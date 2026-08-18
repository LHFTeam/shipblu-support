import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normaliseMessageId } from '../threading';
import type { EmailProvider, OutboundEmail, ParsedInboundEmail, SendResult } from '../types';

/**
 * Development driver. Writes outbound mail to `.mail-outbox/` instead of sending
 * it, so the whole ticketing pipeline can be exercised locally and on staging
 * with no vendor account, no DNS, and no risk of emailing a real customer.
 *
 * Staging runs with EMAIL_PROVIDER=local for exactly that last reason.
 */
export class LocalEmailProvider implements EmailProvider {
  readonly name = 'local';

  constructor(private readonly outboxDir = path.join(process.cwd(), '.mail-outbox')) {}

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

    console.log(`[email:local] wrote ${safeName}.json to ${this.outboxDir}`);
    return { providerMessageId: id, rfcMessageId: email.messageId, accepted: true };
  }

  /** Nothing to verify locally; the endpoint is not reachable from outside. */
  verifySignature(): boolean {
    return true;
  }

  /**
   * Accepts a payload already shaped like ParsedInboundEmail, so tests and local
   * experiments can post a message straight into the pipeline.
   */
  async parseInbound(payload: unknown): Promise<ParsedInboundEmail> {
    const raw = payload as Partial<ParsedInboundEmail> & { receivedAt?: string | Date };

    if (!raw.from?.address) {
      throw new Error('local inbound payload requires from.address');
    }

    return {
      messageId: normaliseMessageId(raw.messageId ?? `local-${Date.now()}@localhost`),
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
      receivedAt: raw.receivedAt ? new Date(raw.receivedAt) : new Date(),
    };
  }
}
