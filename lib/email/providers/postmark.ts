import { timingSafeEqual } from 'node:crypto';
import { formatAddress, formatMessageId, normaliseMessageId } from '../threading';
import type {
  EmailAddress,
  EmailProvider,
  InboundAttachment,
  OutboundEmail,
  ParsedInboundEmail,
  SendResult,
} from '../types';

/**
 * Postmark driver — the reference implementation of EmailProvider.
 *
 * Only this file knows anything about Postmark. Swapping vendor means adding a
 * sibling here and changing EMAIL_PROVIDER; nothing in the ticketing pipeline
 * changes.
 */

const API_URL = 'https://api.postmarkapp.com/email';

type PostmarkInboundPayload = {
  MessageID?: string;
  From?: string;
  FromFull?: { Email?: string; Name?: string };
  ToFull?: { Email?: string; Name?: string }[];
  CcFull?: { Email?: string; Name?: string }[];
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Date?: string;
  MailboxHash?: string;
  Headers?: { Name: string; Value: string }[];
  Attachments?: {
    Name: string;
    Content: string;
    ContentType: string;
    ContentLength: number;
    ContentID?: string;
  }[];
};

function toAddress(full?: { Email?: string; Name?: string }): EmailAddress | null {
  if (!full?.Email) return null;
  return full.Name ? { address: full.Email, name: full.Name } : { address: full.Email };
}

export class PostmarkEmailProvider implements EmailProvider {
  readonly name = 'postmark';

  constructor(
    private readonly serverToken: string,
    /**
     * Shared secret for the inbound webhook. Postmark does not sign inbound
     * payloads, so the accepted practice is Basic Auth on the webhook URL; this
     * is the password half of that.
     */
    private readonly webhookSecret: string | undefined,
  ) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    const headers: { Name: string; Value: string }[] = [
      { Name: 'Message-ID', Value: formatMessageId(email.messageId) },
    ];

    if (email.inReplyTo) {
      headers.push({ Name: 'In-Reply-To', Value: formatMessageId(email.inReplyTo) });
    }
    if (email.references?.length) {
      headers.push({
        Name: 'References',
        Value: email.references.map(formatMessageId).join(' '),
      });
    }
    for (const [name, value] of Object.entries(email.headers ?? {})) {
      headers.push({ Name: name, Value: value });
    }

    const body = {
      From: formatAddress(email.from),
      To: email.to.map(formatAddress).join(', '),
      Cc: email.cc?.length ? email.cc.map(formatAddress).join(', ') : undefined,
      Bcc: email.bcc?.length ? email.bcc.map(formatAddress).join(', ') : undefined,
      ReplyTo: email.replyTo,
      Subject: email.subject,
      TextBody: email.textBody,
      HtmlBody: email.htmlBody,
      MessageStream: 'outbound',
      Headers: headers,
      Attachments: email.attachments?.map((a) => ({
        Name: a.filename,
        Content: a.content.toString('base64'),
        ContentType: a.contentType,
      })),
    };

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Postmark-Server-Token': this.serverToken,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      // Thrown, not swallowed: the queue's retry and backoff is the right place
      // to handle a transient provider failure, and a dead job is a visible
      // record of one that never succeeded.
      throw new Error(`Postmark send failed (${response.status}): ${text}`);
    }

    const result = (await response.json()) as { MessageID?: string };
    return { providerMessageId: result.MessageID ?? null, accepted: true };
  }

  verifySignature(_rawBody: string, headers: Record<string, string>): boolean {
    // No secret configured means the check is disabled; that is a deployment
    // choice, so it is loud in logs rather than silently permissive.
    if (!this.webhookSecret) {
      console.warn('[email:postmark] EMAIL_WEBHOOK_SECRET is not set — inbound is unauthenticated');
      return true;
    }

    const auth = headers['authorization'] ?? headers['Authorization'];
    if (!auth?.startsWith('Basic ')) return false;

    const decoded = Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8');
    const password = decoded.slice(decoded.indexOf(':') + 1);

    const a = Buffer.from(password);
    const b = Buffer.from(this.webhookSecret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  async parseInbound(payload: unknown): Promise<ParsedInboundEmail> {
    const p = payload as PostmarkInboundPayload;

    const headers: Record<string, string> = {};
    for (const h of p.Headers ?? []) {
      // Lowercased so loop-protection can look headers up predictably.
      headers[h.Name.toLowerCase()] = h.Value;
    }

    const from = toAddress(p.FromFull) ?? (p.From ? { address: p.From } : null);
    if (!from) throw new Error('Postmark inbound payload has no sender');

    const references = (headers['references'] ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(normaliseMessageId);

    const inReplyTo = headers['in-reply-to']
      ? normaliseMessageId(headers['in-reply-to'])
      : undefined;

    const attachments: InboundAttachment[] = (p.Attachments ?? []).map((a) => ({
      filename: a.Name,
      contentType: a.ContentType,
      content: Buffer.from(a.Content, 'base64'),
      contentId: a.ContentID,
      isInline: Boolean(a.ContentID),
    }));

    /**
     * OriginalRecipient carries the envelope recipient, which is where the
     * plus-addressed reply token survives even when the To header was rewritten
     * by a forwarder. Threading checks it via deliveredTo.
     */
    const deliveredTo = p.OriginalRecipient ? [p.OriginalRecipient] : undefined;

    return {
      messageId: normaliseMessageId(p.MessageID ?? headers['message-id'] ?? `pm-${Date.now()}`),
      inReplyTo,
      references,
      from,
      to: (p.ToFull ?? []).map(toAddress).filter((a): a is EmailAddress => a !== null),
      cc: (p.CcFull ?? []).map(toAddress).filter((a): a is EmailAddress => a !== null),
      deliveredTo,
      subject: p.Subject ?? '',
      textBody: p.TextBody ?? '',
      htmlBody: p.HtmlBody,
      attachments,
      headers,
      spamScore: headers['x-spam-score'] ? Number(headers['x-spam-score']) : null,
      spfPass: headers['received-spf'] ? /^\s*pass/i.test(headers['received-spf']) : null,
      dkimPass: null,
      receivedAt: p.Date ? new Date(p.Date) : new Date(),
    };
  }
}
