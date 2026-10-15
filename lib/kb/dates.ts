/**
 * Dates for the help centre's server-rendered pages, in the reader's language.
 *
 * Apart from `lib/kb/locale.ts` because that module is in the browser bundle —
 * the help centre's forms and the widget take `t()` from it — and these are not
 * fit to be: each one returns the engine's whole string, and the punctuation in
 * that string is locale data that Node and every browser ship their own copy of
 * (`docs/PROJECT-STATE.md` §6.96). Drawn by a server
 * component, that is harmless, because only the server ever writes it. Drawn
 * by a client component, the server's text and the browser's differ and React
 * rebuilds the page. The `client-dates` repo rule refuses a whole-string date
 * format in any module a client component can reach, so importing one of these
 * into one fails CI rather than a customer's page; a date a client component
 * draws goes through `lib/format.ts`, which joins the fields itself.
 */

import { TEAM_TIME_ZONE } from '@/lib/hours/zone';
import type { Locale } from './locale';

/** Dates render in the reader's locale but always in ShipBlu's timezone. */
export function formatArticleDate(locale: Locale, value: Date | string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    dateStyle: 'long',
    timeZone: TEAM_TIME_ZONE,
  }).format(new Date(value));
}

/**
 * A date *and* a clock time, for a delivery update.
 *
 * Latin digits even in Arabic, unlike `formatArticleDate` above and for the same
 * reason `formatOpening` forces them: this timestamp is printed beside a tracking
 * number, which is a Latin identifier whatever the page's language. `٢٤ أغسطس ·
 * ١٦:٠٤` next to `SB4820119` reads as two alphabets for the same idea, and
 * Egyptian screens — prices, phone numbers, the parcel numbers themselves — are
 * written in Latin digits.
 */
export function formatTimestamp(locale: Locale, value: Date | string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TEAM_TIME_ZONE,
  }).format(new Date(value));
}

/**
 * A bare `YYYY-MM-DD` from the shipping platform, formatted as the day it names.
 *
 * **`timeZone: 'UTC'`, and that is the opposite of every other formatter here on
 * purpose.** A calendar date carries no time and no offset, so `new Date()`
 * fixes it to midnight UTC; formatting *that* instant in Africa/Cairo would move
 * it to 02:00 the same day, which is harmless — but the same code west of
 * Greenwich renders the day before, and the platform's estimated delivery date
 * would read as a day early for anyone reading from Europe or the Americas.
 * Formatting in the zone the parse implied is what makes the output the date the
 * platform actually sent, in every reader's location.
 *
 * Only for the platform's calendar dates. Anything that is a real instant —
 * every tracking event, every message — goes through `formatTimestamp`, which is
 * correct precisely because it converts to Cairo.
 */
export function formatCalendarDate(locale: Locale, value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;

  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(parsed);
}
