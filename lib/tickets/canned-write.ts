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
  // Stored as both forms: email sends HTML, WhatsApp and the social channels
  // send text, and deriving one from the other at send time would mean every
  // channel guessing at line breaks. An unwritten language stays empty in both
  // — `textToHtml('')` would otherwise leave markup that reads as a body.
  const bodyHtmlAr = body.ar ? textToHtml(body.ar) : '';
  const bodyHtmlEn = body.en ? textToHtml(body.en) : '';

  return {
    bodyTextAr: body.ar,
    bodyHtmlAr,
    bodyTextEn: body.en,
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
    bodyText: body.ar || body.en,
    bodyHtml: bodyHtmlAr || bodyHtmlEn,
  };
}
