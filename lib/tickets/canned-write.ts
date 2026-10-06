import { textToHtml } from '@/lib/html/sanitize';
import type { BilingualBody } from './canned';

/**
 * Every body column a canned response stores, derived from the text a person
 * wrote in each language.
 *
 * One function because two writers produce these rows — `saveCannedResponse`
 * from the admin form and `seed_canned_responses` from the starter library —
 * and the send paths read the columns without knowing which wrote them. A
 * private copy in the seed is how a seeded row would come to differ from one
 * saved in the console in a way only a customer's inbox shows: an HTML body
 * built differently, or a superseded column left blank.
 *
 * Kept apart from `canned.ts` because that module is imported by the composer,
 * which runs in the browser, and `textToHtml` lives beside the sanitiser.
 */
export function cannedBodyColumns(body: BilingualBody) {
  // Line endings first, for the reason `textToHtml` gives: a browser submits a
  // textarea's breaks as CRLF. `textToHtml` copes on its own, so the HTML never
  // showed it, but the text columns kept the `\r` — on every WhatsApp and
  // social send, and in the seed's comparison, where a seeded response saved
  // once in the console unchanged read as edited by the team ever after.
  const ar = body.ar.replace(/\r\n?/g, '\n');
  const en = body.en.replace(/\r\n?/g, '\n');

  // Stored as both forms: email sends HTML, WhatsApp and the social channels
  // send text, and deriving one from the other at send time would mean every
  // channel guessing at line breaks. An unwritten language stays empty in both
  // — `textToHtml('')` would otherwise leave markup that reads as a body.
  const bodyHtmlAr = ar ? textToHtml(ar) : '';
  const bodyHtmlEn = en ? textToHtml(en) : '';

  return {
    bodyTextAr: ar,
    bodyHtmlAr,
    bodyTextEn: en,
    bodyHtmlEn,
    /*
      The superseded pair, written for as long as it still exists.

      `db/schema/config.ts` keeps these columns through one release because the
      worker and the four crons deploy separately from the service that runs the
      migration, and the old `sendCannedReply` selects them. That only buys
      anything if they still say something: a response created after the
      migration and never written here is `''` to the old code, which sends a
      customer an empty automated reply rather than falling back to anything.
      Arabic first, for the reason `DEFAULT_LOCALE` is — a single body can only
      answer one half of the queue, and this is the larger half.

      Goes when the columns do; `docs/PROJECT-STATE.md` §5.5 carries the removal.
    */
    bodyText: ar || en,
    bodyHtml: bodyHtmlAr || bodyHtmlEn,
  };
}
