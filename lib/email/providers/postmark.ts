import { safeEqual } from '@/lib/auth/tokens';
import { isTimeout, WRITE_TIMEOUT_MS } from '@/lib/http/deadline';
import { parseDateHeader } from '../date-header';
import { fallbackMessageId } from '../fallback-id';
import { formatAddress, formatMessageId, normaliseMessageId } from '../threading';
import type {
  EmailAddress,
  EmailProvider,
  InboundAttachment,
  InboundVerdict,
  OutboundEmail,
  ParsedInboundEmail,
  SendResult,
} from '../types';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';

// Two tags, as before: sending logs as `postmark`, and the inbound webhook's
// check as `email:postmark`, the source name its route logs deliveries under.
const log = logger('postmark');
const inboundLog = logger('email:postmark');

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

    // Every send runs in a job, so it gets the write deadline Graph sends get:
    // long enough not to give up on an email Postmark is still accepting, short
    // enough to end inside the stalled window, which is the margin the queue
    // has if the worker's heartbeat fails (`WRITE_TIMEOUT_MS`).
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Postmark-Server-Token': this.serverToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new Error(`Postmark send did not answer in ${WRITE_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }

    // Read inside the same deadline, which governs the body as well as the
    // status: a deadline passing mid-body rejects with the signal's own reason.
    let text: string | null;
    try {
      text = await response.text();
    } catch (error) {
      if (!response.ok) {
        throw new Error(
          `Postmark send failed (${response.status}), and its reason never arrived` +
            (isTimeout(error) ? ` in ${WRITE_TIMEOUT_MS / 1000}s` : ''),
        );
      }
      // A 2xx is Postmark's answer: the email is accepted and will go. Retrying
      // it sends the customer a second copy — with a fresh Message-ID on
      // transactional mail, so not even their client can fold the two. What is
      // lost is only Postmark's own id, which the message row records and
      // nothing reads.
      log.warn(
        `send accepted with ${response.status}, but its body never arrived: ` +
          `${errorMessage(error)}`,
      );
      text = null;
    }

    if (!response.ok) {
      // Thrown, not swallowed: the queue's retry and backoff is the right place
      // to handle a transient provider failure, and a dead job is a visible
      // record of one that never succeeded.
      throw new Error(`Postmark send failed (${response.status}): ${text}`);
    }

    // Parsed apart from the read for the same reason: a 2xx whose body is not
    // the JSON we expected is still an accepted send.
    let result: { MessageID?: string } = {};
    try {
      result = text ? (JSON.parse(text) as { MessageID?: string }) : {};
    } catch {
      // No id to report; the send stands.
    }

    // Postmark's MessageID is its own UUID, not the Message-ID header it
    // stamps on the wire, so it is deliberately not reported as rfcMessageId.
    // The header we set above is normally honoured; when it is not, our id is
    // still in References, which Postmark leaves alone.
    return { providerMessageId: result.MessageID ?? null, rfcMessageId: null, accepted: true };
  }

  verifySignature(_rawBody: string, headers: Record<string, string>): InboundVerdict {
    // An unset secret used to disable the check, with a warning as the only
    // sign — so a deploy that lost the variable took any POST to the URL for a
    // customer's email. It refuses instead, in every environment, which is the
    // answer the WhatsApp and Meta verifiers give an empty app secret. There is
    // no environment where accepting is safe: this driver only ever receives
    // mail at a URL Postmark can reach, which is a URL anyone can reach. The
    // development convenience belongs to the `local` driver.
    //
    // A refused delivery is stored with this reason and answered 401, which
    // Postmark retries for about ten hours. Setting the secret on the service
    // and as the password in Postmark's inbound webhook URL inside that window
    // should let the retries through — whether a retry already scheduled picks
    // up a changed URL is not something we have observed.
    if (!this.webhookSecret) {
      inboundLog.error('EMAIL_WEBHOOK_SECRET is not set — refusing inbound mail');
      return {
        verified: false,
        reason: 'EMAIL_WEBHOOK_SECRET is not set; every delivery is refused',
      };
    }

    // The scheme is case-insensitive (RFC 7617 §2); an intermediary that
    // lower-cases it must not turn every genuine delivery into a refusal.
    const auth = headers['authorization'] ?? headers['Authorization'];
    const basic = auth ? /^basic +(.+)$/i.exec(auth) : null;
    if (!basic) return { verified: false, reason: 'no Basic Auth credential on the request' };

    // A credential is `user:password`. Without the colon there is no password
    // half, and reading the whole token as one would accept the bare secret.
    const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) return { verified: false, reason: 'Basic Auth credential has no password' };
    const password = decoded.slice(colon + 1);

    if (!safeEqual(password, this.webhookSecret)) {
      return { verified: false, reason: 'Basic Auth password did not match EMAIL_WEBHOOK_SECRET' };
    }
    return { verified: true };
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
      // The sender's real Message-ID first, Postmark's internal id only as a
      // fallback. This is stored as the message's channel id and is what a
      // later reply's References will quote — Postmark's UUID appears in no
      // mail client anywhere, so preferring it would break threading onto any
      // inbound message.
      messageId: normaliseMessageId(
        headers['message-id'] ?? p.MessageID ?? fallbackMessageId('pm', payload),
      ),
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
      // The sender's claim, kept as evidence. When the mail arrived is not
      // something the payload can say; see `InboundDelivery`.
      dateHeader: parseDateHeader(p.Date),
    };
  }
}
