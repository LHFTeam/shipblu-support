import type { Locale } from '@/lib/kb/locale';

/**
 * Dropping a canned response into what an agent is already writing.
 *
 * Separate from the composer because this is the part with an off-by-one in it.
 * The naive version — append to the end, or replace the box outright — is wrong
 * in the case that actually happens: an agent types a sentence of their own,
 * realises the rest is boilerplate, and puts the cursor where the boilerplate
 * goes. Replacing would discard what they wrote, and appending would put it
 * after their sign-off.
 */

export type Insertion = { text: string; caret: number };

/**
 * Inserts `snippet` at the selection, replacing whatever is selected.
 *
 * The caret comes back at the end of what was inserted, so the agent carries on
 * typing after the boilerplate rather than in front of it.
 *
 * Blank lines around the seam are the other half of this. Pasting a paragraph
 * straight against the end of a sentence produces "…on its way.Hi there" —
 * correct by the letter and wrong on screen — so a break is added where one is
 * missing, and never where one is already there.
 */
export function insertCanned(
  current: string,
  snippet: string,
  selectionStart: number,
  selectionEnd: number,
): Insertion {
  const body = snippet.trim();
  if (!body) return { text: current, caret: selectionEnd };

  // A caret arriving out of range means the textarea and this disagree about
  // the value — clamp rather than produce a string neither of them expects.
  const start = clamp(selectionStart, 0, current.length);
  const end = clamp(Math.max(selectionEnd, selectionStart), start, current.length);

  const before = current.slice(0, start);
  const after = current.slice(end);

  const lead = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const tail = after && !after.startsWith('\n\n') ? (after.startsWith('\n') ? '\n' : '\n\n') : '';

  const text = `${before}${lead}${body}${tail}${after}`;
  return { text, caret: before.length + lead.length + body.length };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(value, min), max);
}

/**
 * Choosing which language of a canned response to insert or send.
 *
 * Here rather than in the composer because two callers need the same answer and
 * only one of them is a browser: an agent picking from the dropdown, and the
 * automation engine sending one unattended. A response written in one language
 * only would otherwise be "missing" to one of them and present to the other.
 */

/**
 * The site's locales, not a second set of them.
 *
 * Aliased rather than re-declared: `lib/kb/locale.ts` already owns which
 * languages this product has, and two independent unions that happen to match
 * today is how the canned picker would come to offer two of three. The
 * exhaustiveness is enforced where it can be seen — the composer's
 * `Record<CannedLocale, string>` label maps stop compiling the day a third
 * locale is added, which is the point at which the ordering below needs a human
 * anyway.
 *
 * The order is the picker's: Arabic first, because it is what the majority of
 * ShipBlu's customers write and `DEFAULT_LOCALE` already says so.
 */
export type CannedLocale = Locale;
export const CANNED_LOCALES = ['ar', 'en'] as const satisfies readonly CannedLocale[];

/**
 * The two bodies of a response.
 *
 * Text, always: `availableLocales` decides on what a person would read, and the
 * HTML is derived from it rather than being a second opinion about which
 * languages exist.
 */
export type BilingualBody = { ar: string; en: string };

/**
 * Which languages this response can actually be sent in.
 *
 * Blank rather than null is what an unwritten side looks like — the columns are
 * `not null default ''` — so the test is on the trimmed text and not on the
 * column being present.
 */
export function availableLocales(body: BilingualBody): CannedLocale[] {
  return CANNED_LOCALES.filter((locale) => body[locale].trim().length > 0);
}

/**
 * The language a response will actually go out in: the one asked for, or the
 * only one it was written in.
 *
 * The fallback is deliberate and it is not a silent substitution, because
 * neither caller lets it happen unannounced. The picker labels a response that
 * has only the other language, so the agent chooses it knowing — and what they
 * get is then sitting in the textarea in front of them. The automation engine
 * has nobody to tell, and sends it because an acknowledgement a customer has to
 * read twice beats an acknowledgement that never arrives.
 *
 * Hiding a response that lacks the selected language was the other option, and
 * it is worse in the case that actually happens here: the team writes the
 * Arabic first, so an agent answering an English-writing customer would open a
 * dropdown with most of the boilerplate missing and no way to tell that it
 * exists.
 *
 * Null only when the response has no body at all in either language, which
 * `saveCannedResponse` refuses to create.
 */
export function resolveLocale(body: BilingualBody, wanted: CannedLocale): CannedLocale | null {
  if (body[wanted].trim()) return wanted;
  return availableLocales(body)[0] ?? null;
}
