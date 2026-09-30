import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDateHeader } from '../date-header';
import { fallbackMessageId } from '../fallback-id';
import { normaliseMessageId } from '../threading';
import type {
  EmailProvider,
  InboundVerdict,
  OutboundEmail,
  ParsedInboundEmail,
  SendResult,
} from '../types';
import { logger } from '@/lib/log';

const log = logger('email:local');

/**
 * Development driver. Writes outbound mail to `.mail-outbox/` instead of sending
 * it, so the whole ticketing pipeline can be exercised locally and on staging
 * with no vendor account, no DNS, and no risk of emailing a real customer.
 *
 * Staging runs with EMAIL_PROVIDER=local for exactly that last reason.
 */
export class LocalEmailProvider implements EmailProvider {
  readonly name = 'local';

  constructor(
    /**
     * Whether an inbound post is taken as genuine. There is nothing to verify
     * it against — no vendor, no secret — so the answer is where this runs: yes
     * on a laptop, where the endpoint is not reachable from outside; no under
     * NODE_ENV=production, where it is. Staging is both `local` and
     * production, on a public URL, and was the case this is for.
     */
    private readonly options: { acceptInbound: boolean },
    private readonly outboxDir = path.join(process.cwd(), '.mail-outbox'),
  ) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    await mkdir(this.outboxDir, { recursive: true });

    const id = normaliseMessageId(email.messageId);
    const safeName = `${Date.now()}-${id.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    const record = {
      ...email,
      attachments: email.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.content.length,
      })),
      writtenAt: new Date().toISOString(),
    };

    await writeFile(
      path.join(this.outboxDir, `${safeName}.json`),
      JSON.stringify(record, null, 2),
      'utf8',
    );

    log.info(`wrote ${safeName}.json to ${this.outboxDir}`);
    return { providerMessageId: id, rfcMessageId: email.messageId, accepted: true };
  }

  verifySignature(): InboundVerdict {
    if (this.options.acceptInbound) return { verified: true };
    return {
      verified: false,
      reason: 'EMAIL_PROVIDER=local accepts inbound mail only outside NODE_ENV=production',
    };
  }

  /**
   * Accepts a payload already shaped like ParsedInboundEmail, so tests and local
   * experiments can post a message straight into the pipeline.
   *
   * Everything except when it arrived, which is the stored delivery's for this
   * driver as for every other (`InboundDelivery`). A local experiment that wants
   * a mail from a skewed clock sets `dateHeader`, the field that carries one.
   */
  async parseInbound(payload: unknown): Promise<ParsedInboundEmail> {
    const raw = payload as Partial<Omit<ParsedInboundEmail, 'dateHeader'>> & {
      dateHeader?: string | null;
    };

    if (!raw.from?.address) {
      throw new Error('local inbound payload requires from.address');
    }

    // This driver used to take `receivedAt` from the payload, so an experiment
    // written against it would now be stamped with its arrival without a word.
    // It still lands; the warning is so the backdating that did not happen is
    // not mistaken for one that did.
    if ('receivedAt' in raw) {
      log.warn(
        'ignoring receivedAt on a local payload: a mail is stamped when it reached us; set dateHeader to simulate a skewed clock',
      );
    }

    return {
      messageId: normaliseMessageId(
        raw.messageId ?? `${fallbackMessageId('local', payload)}@localhost`,
      ),
      inReplyTo: raw.inReplyTo ? normaliseMessageId(raw.inReplyTo) : undefined,
      references: (raw.references ?? []).map(normaliseMessageId),
      from: raw.from,
      to: raw.to ?? [],
      cc: raw.cc ?? [],
      deliveredTo: raw.deliveredTo,
      subject: raw.subject ?? '',
      textBody: raw.textBody ?? '',
      htmlBody: raw.htmlBody,
      attachments: raw.attachments ?? [],
      headers: raw.headers ?? {},
      spamScore: raw.spamScore ?? null,
      spfPass: raw.spfPass ?? null,
      dkimPass: raw.dkimPass ?? null,
      dateHeader: parseDateHeader(raw.dateHeader),
    };
  }
}
