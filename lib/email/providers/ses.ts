import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import PostalMime from 'postal-mime';
import { confirmSubscription, verifySnsMessage, type SnsMessage } from '@/lib/aws/sns';
import { buildRawMessage } from '../mime';
import type {
  EmailProvider,
  InboundAttachment,
  OutboundEmail,
  ParsedInboundEmail,
  SendResult,
} from '../types';

/**
 * Amazon SES driver.
 *
 * Outbound goes through SES v2 with Raw content, because the simple API cannot
 * set In-Reply-To or References and those are what make a reply thread rather
 * than start a new conversation in the customer's client.
 *
 * The important quirk: **SES overwrites Message-ID on send.** Our own id never
 * reaches the recipient, so the customer's reply carries SES's id in
 * In-Reply-To and matching on our id would silently fail for every threaded
 * reply. Two things compensate:
 *
 *   1. our id is appended to References, which SES leaves untouched, so the
 *      References-based lookup still finds the thread;
 *   2. the id SES returns is recorded on the message row, so a reply quoting
 *      *that* id resolves too.
 *
 * The plus-addressed reply token remains the primary signal regardless — it
 * survives clients that drop threading headers entirely.
 */

export type SesConfig = {
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Configuration set, for per-stream event publishing. Optional. */
  configurationSet?: string;
};

export class SesEmailProvider implements EmailProvider {
  readonly name = 'ses';

  private ses: SESv2Client;
  private s3: S3Client | null = null;
  private readonly config: SesConfig;

  constructor(config: SesConfig) {
    this.config = config;

    // Credentials are omitted when running on infrastructure with an instance
    // role; the SDK's default chain then picks them up. On Render there is no
    // role, so the keys are supplied — but not requiring them keeps the door
    // open for moving the worker later.
    this.ses = new SESv2Client({
      region: config.region,
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    // Our Message-ID is appended rather than prepended: References is
    // oldest-first, and this message is the newest thing in the chain.
    const references = [...(email.references ?? [])];
    if (!references.includes(email.messageId)) references.push(email.messageId);

    const raw = buildRawMessage({ ...email, references });

    const result = await this.ses.send(
      new SendEmailCommand({
        Content: { Raw: { Data: new Uint8Array(raw) } },
        ...(this.config.configurationSet
          ? { ConfigurationSetName: this.config.configurationSet }
          : {}),
      }),
    );

    return {
      // SES returns a bare id; the header it actually stamps is
      // <id@region.amazonses.com>, which is the form a reply will quote.
      providerMessageId: result.MessageId
        ? `${result.MessageId}@${this.config.region}.amazonses.com`
        : null,
      accepted: Boolean(result.MessageId),
    };
  }

  /**
   * SNS signs with RSA over a canonical string rather than an HMAC header, and
   * verifying it needs a certificate fetch — which this synchronous interface
   * cannot do. So this returns false and the real check happens in
   * `handleControlMessage`, which the route awaits.
   */
  verifySignature(): boolean {
    return false;
  }

  async verifyWebhook(rawBody: string): Promise<boolean> {
    const message = parseSns(rawBody);
    if (!message) return false;
    return verifySnsMessage(message);
  }

  /**
   * Completes the SNS subscription handshake.
   *
   * Returns true when the payload was a control message and needs no further
   * processing; false when it is a notification carrying an email.
   */
  async handleControlMessage(payload: unknown): Promise<boolean> {
    const message = payload as SnsMessage;
    if (message?.Type === 'SubscriptionConfirmation') {
      await confirmSubscription(message);
      return true;
    }
    return message?.Type === 'UnsubscribeConfirmation';
  }

  async parseInbound(payload: unknown): Promise<ParsedInboundEmail> {
    const sns = payload as SnsMessage;

    const inner = typeof sns?.Message === 'string' ? safeJson(sns.Message) : sns;
    const notification = inner as SesNotification;

    const raw = await this.loadRawEmail(notification);
    if (!raw) throw new Error('SES notification carried no message content');

    const parsed = await PostalMime.parse(raw);

    const headers: Record<string, string> = {};
    for (const header of parsed.headers ?? []) {
      // Later duplicates win, matching how a receiver reads the last Received.
      headers[header.key.toLowerCase()] = header.value;
    }

    const attachments: InboundAttachment[] = (parsed.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? 'attachment',
      contentType: attachment.mimeType ?? 'application/octet-stream',
      content: Buffer.from(
        typeof attachment.content === 'string'
          ? Buffer.from(attachment.content, 'base64')
          : new Uint8Array(attachment.content as ArrayBuffer),
      ),
      contentId: attachment.contentId?.replace(/^<|>$/g, ''),
      isInline: attachment.disposition === 'inline',
    }));

    const verdicts = notification.receipt;

    return {
      messageId: stripAngles(parsed.messageId ?? headers['message-id'] ?? ''),
      inReplyTo: parsed.inReplyTo ? stripAngles(parsed.inReplyTo) : undefined,
      references: parseReferences(headers.references ?? parsed.references ?? ''),

      from: {
        address: parsed.from?.address ?? '',
        name: parsed.from?.name || undefined,
      },
      to: (parsed.to ?? []).map((a) => ({ address: a.address ?? '', name: a.name || undefined })),
      cc: (parsed.cc ?? []).map((a) => ({ address: a.address ?? '', name: a.name || undefined })),
      // The envelope recipients, which is where the plus-addressed reply token
      // survives even when the To header shows a bare address.
      deliveredTo: notification.receipt?.recipients ?? [],

      subject: parsed.subject ?? '',
      textBody: parsed.text ?? '',
      htmlBody: parsed.html ?? undefined,

      attachments,
      headers,

      spamScore: null,
      spfPass: verdicts ? verdicts.spfVerdict?.status === 'PASS' : null,
      dkimPass: verdicts ? verdicts.dkimVerdict?.status === 'PASS' : null,

      receivedAt: parsed.date ? new Date(parsed.date) : new Date(),
    };
  }

  /**
   * SES delivers inbound mail one of two ways, and both are supported because
   * the choice is made by a receipt rule, not by us.
   *
   *  - the SNS action inlines the message, but caps it at 150KB — which a
   *    single invoice PDF exceeds, so it cannot be the only path;
   *  - the S3 action writes the message to a bucket and notifies, which is what
   *    anything with attachments needs.
   */
  private async loadRawEmail(notification: SesNotification): Promise<Buffer | null> {
    if (typeof notification.content === 'string') {
      return Buffer.from(notification.content, 'base64');
    }

    const s3Action = notification.receipt?.action;
    if (s3Action?.type === 'S3' && s3Action.bucketName && s3Action.objectKey) {
      const client = (this.s3 ??= new S3Client({
        region: this.config.region,
        ...(this.config.accessKeyId && this.config.secretAccessKey
          ? {
              credentials: {
                accessKeyId: this.config.accessKeyId,
                secretAccessKey: this.config.secretAccessKey,
              },
            }
          : {}),
      }));

      const object = await client.send(
        new GetObjectCommand({ Bucket: s3Action.bucketName, Key: s3Action.objectKey }),
      );

      const bytes = await object.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    }

    return null;
  }
}

type SesNotification = {
  notificationType?: string;
  /** Base64 raw MIME, present only for the SNS delivery action. */
  content?: string;
  receipt?: {
    recipients?: string[];
    spfVerdict?: { status?: string };
    dkimVerdict?: { status?: string };
    spamVerdict?: { status?: string };
    action?: { type?: string; bucketName?: string; objectKey?: string };
  };
};

function parseSns(rawBody: string): SnsMessage | null {
  try {
    const parsed = JSON.parse(rawBody) as SnsMessage;
    return parsed?.Type ? parsed : null;
  } catch {
    return null;
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function stripAngles(value: string): string {
  return value.trim().replace(/^<|>$/g, '');
}

function parseReferences(value: string | string[]): string[] {
  const raw = Array.isArray(value) ? value.join(' ') : value;
  return raw.split(/\s+/).map(stripAngles).filter(Boolean);
}
