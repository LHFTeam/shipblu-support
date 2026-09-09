import { stripQuotedHtml, stripQuotedText } from '@/lib/email/quote-strip';
import { htmlToText, sanitiseEmailHtml } from '@/lib/html/sanitize';
import type { ParsedInboundEmail } from '@/lib/email/types';

/** The four body columns an inbound email becomes, however it arrived. */
export type StoredEmailBody = {
  /** Quote-stripped and sanitised. Null when the mail carried no HTML part. */
  bodyHtml: string | null;
  /** The text part when there is one, else the sanitised HTML flattened. */
  bodyText: string;
  /** What arrived, before stripping or sanitising. */
  rawBody: string | null;
  /** Which strip rule fired, for debugging a thread that stripped wrongly. */
  strippedBy: string | null;
};

/**
 * Turns a parsed inbound email into the columns a message row stores.
 *
 * One copy for both email paths — the customer's ticket and a side
 * conversation's reply from a hub — because this is where the repo's first
 * non-negotiable is honoured: attacker-controlled HTML is sanitised **on the
 * way in**, so nothing downstream has to remember to do it on the way out. CI
 * can keep `sanitize-html` confined to one module but cannot tell which side of
 * the read/write boundary a call sits on, which makes a second copy of this
 * sequence the cheapest possible way to publish raw mail HTML.
 *
 * The order matters and is not interchangeable. Quotes come off first so the
 * sanitiser is never asked to reason about a forwarded thread, and `bodyText`
 * prefers the real text part over flattened HTML because a plain-text reply
 * survives that trip intact while `htmlToText` of a marketing email does not.
 * `rawBody` keeps the original either way: it is what an agent reads when the
 * strip took too much, and the only copy once the quote is gone.
 */
export function readEmailBody(email: ParsedInboundEmail): StoredEmailBody {
  const rawHtml = email.htmlBody ?? null;
  const strippedHtml = rawHtml ? stripQuotedHtml(rawHtml) : null;
  const strippedText = stripQuotedText(email.textBody ?? '');

  const bodyHtml = strippedHtml ? sanitiseEmailHtml(strippedHtml.visible) : null;

  return {
    bodyHtml,
    bodyText: strippedText.visible.trim()
      ? strippedText.visible
      : bodyHtml
        ? htmlToText(bodyHtml)
        : '',
    rawBody: rawHtml ?? email.textBody ?? null,
    strippedBy: strippedText.matchedBy ?? strippedHtml?.matchedBy ?? null,
  };
}
