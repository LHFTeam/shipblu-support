import type { Locale } from './locale';

/**
 * Which language a piece of imported content is written in.
 *
 * Freshdesk's Solutions API does not report a language on a category or an
 * article, so it has to be read off the text. That is reliable here in a way
 * language detection usually is not: Arabic and English use different scripts,
 * so this is a script test rather than a guess about vocabulary.
 *
 * The threshold is deliberately low. A support article written in Arabic is
 * full of Latin text — "ShipBlu", tracking numbers, URLs, "COD" — so demanding
 * a majority of Arabic characters would file most real Arabic articles as
 * English. The reverse almost never happens: an English article contains no
 * Arabic at all, so a small amount of Arabic script is strong evidence.
 */

/** Arabic script beyond this share of the letters means the text is Arabic. */
const ARABIC_THRESHOLD = 0.2;

/** Bodies can be long, and the first couple of thousand characters settle it. */
const SAMPLE_LENGTH = 2000;

const ARABIC = /\p{Script=Arabic}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

export type LetterCounts = { arabic: number; latin: number };

/**
 * Counts letters by script, ignoring digits, punctuation and whitespace.
 *
 * Digits are excluded on purpose, including Arabic-Indic ones: a tracking
 * number is not evidence of a language, and counting it either way skews short
 * titles that are mostly reference codes.
 */
export function countLetters(text: string): LetterCounts {
  let arabic = 0;
  let latin = 0;

  for (const character of text.slice(0, SAMPLE_LENGTH)) {
    if (!LETTER.test(character)) continue;
    if (ARABIC.test(character)) arabic += 1;
    else if (LATIN.test(character)) latin += 1;
  }

  return { arabic, latin };
}

export function arabicRatio(text: string): number {
  const { arabic, latin } = countLetters(text);
  const total = arabic + latin;
  return total === 0 ? 0 : arabic / total;
}

/**
 * What an unreadable sample is filed as.
 *
 * Pinned to English rather than following DEFAULT_LOCALE. The site's default
 * locale answers "which language does the front door open in", which is a
 * product decision that has since changed; this answers "what do we call a
 * Freshdesk article whose title is just a reference number", and re-filing
 * years of imported content is not something a landing-page change should do.
 */
const UNREADABLE_FALLBACK: Locale = 'en';

/**
 * The locale for a piece of content, from one or more samples.
 *
 * Samples are concatenated rather than voted on, so a short Arabic title with a
 * long Arabic body is judged on both. Text with no letters at all — a title
 * that is just a reference number — falls back to English, which is the only
 * honest answer when there is nothing to read.
 */
export function detectLocale(...samples: (string | null | undefined)[]): Locale {
  const combined = samples.filter(Boolean).join(' ');
  const { arabic, latin } = countLetters(combined);

  if (arabic + latin === 0) return UNREADABLE_FALLBACK;
  return arabic / (arabic + latin) >= ARABIC_THRESHOLD ? 'ar' : 'en';
}

/**
 * The locale for a whole category, decided by its articles.
 *
 * A category's own name is often too short to be decisive — "FAQ" and "COD"
 * read as English whatever language the articles are in — so the articles win
 * and the name only breaks a tie. Every article in a category is then filed
 * under the category's locale, because the public routes reach an article
 * through its category and the two disagreeing makes the article unreachable.
 */
export function detectCategoryLocale(
  categoryName: string,
  articleSamples: string[],
): { locale: Locale; disagreements: number } {
  const votes = articleSamples.map((sample) => detectLocale(sample));

  const arabic = votes.filter((vote) => vote === 'ar').length;
  const english = votes.length - arabic;

  const locale: Locale =
    votes.length === 0
      ? detectLocale(categoryName)
      : arabic === english
        ? detectLocale(categoryName)
        : arabic > english
          ? 'ar'
          : 'en';

  return { locale, disagreements: votes.filter((vote) => vote !== locale).length };
}

/**
 * Whether a "translation" is a translation at all.
 *
 * Freshdesk lets a translation be saved with only the title changed, and the
 * result is a record that claims to be Arabic and carries the English body
 * verbatim. That is not something script detection can be trusted to catch: an
 * Arabic article legitimately runs to mostly Latin characters when it is a
 * technical walkthrough full of code, paths and product names, which is exactly
 * the kind of article most likely to be left untranslated. Comparing the two
 * bodies is decisive where counting letters is a guess — identical text has not
 * been translated, whatever it is written in.
 *
 * Whitespace is normalised first, because the editor rewrites line endings and
 * indentation on save without anybody typing a word.
 */
export function looksUntranslated(
  primary: string | null | undefined,
  translated: string | null | undefined,
): boolean {
  const a = normalise(primary);
  const b = normalise(translated);
  return a.length > 0 && a === b;
}

function normalise(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
