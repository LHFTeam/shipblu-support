import { t, type Locale } from '@/lib/kb/locale';

/**
 * What a survey says, and the rules the words are held to.
 *
 * Pure: the admin form counts against these limits as the admin types, the
 * save action refuses what breaks them, and the stage that builds Messenger's
 * feedback card reads the same table — so a wording that saves is a wording
 * that sends. The limits are Meta's (title ≤ 65, subtitle ≤ 80, button ≤ 20,
 * question 5–85, placeholder ≤ 65, no URLs), enforced on every rule rather
 * than only one scoped to Facebook, because a group rule with no channel
 * reaches Facebook too. Lengths are code points, which is what Meta counts;
 * `.length` counts UTF-16 units and would refuse an Arabic sentence with an
 * emoji in it a character early.
 */

export const WORDING_FIELDS = [
  'question',
  'intro',
  'subtitle',
  'button',
  'commentPrompt',
  'thanks',
] as const;

export type WordingField = (typeof WORDING_FIELDS)[number];

export type WordingLimit = {
  /** Where the string goes, for the form's hint and the preview's slot. */
  label: string;
  /** Meta's minimum, where it has one; an empty string is always allowed (it falls back). */
  min: number | null;
  /**
   * The most it may be, in code points: Meta's maximum for a field of
   * Messenger's card, and for the thanks a length that reads as a thanks.
   */
  max: number | null;
  /**
   * The most it may be in UTF-8 bytes, where a message's limit is counted in
   * them: the thanks is sent as a message after a tapped rating, with a line
   * after it (`quickReplyThanks`), and Instagram refuses a message over 1,000
   * bytes. Code points cannot hold that — an Arabic letter is two bytes, an
   * emoji four — so 300 of them can be 1,200. What is left of the 1,000 once
   * the longer of the two follow-up lines is sent; `meta-survey.test.ts`
   * holds the sum.
   */
  maxBytes: number | null;
  /** Whether Meta refuses a URL in it. */
  noUrl: boolean;
};

export const WORDING_LIMITS: Record<WordingField, WordingLimit> = {
  question: { label: 'The question', min: 5, max: 85, maxBytes: null, noUrl: true },
  intro: { label: 'First line', min: null, max: 65, maxBytes: null, noUrl: true },
  subtitle: { label: 'Second line', min: null, max: 80, maxBytes: null, noUrl: true },
  button: { label: 'Button', min: null, max: 20, maxBytes: null, noUrl: true },
  commentPrompt: { label: 'Comment prompt', min: null, max: 65, maxBytes: null, noUrl: true },
  thanks: { label: 'Thanks', min: null, max: 300, maxBytes: 900, noUrl: false },
};

/** One language's worth of a rule's strings. */
export type Wording = Record<WordingField, string>;

export type WordingLocale = 'ar' | 'en';

/** A rule's strings in both languages, as the row holds them. */
export type WordingPair = {
  [K in WordingField as `${K}Ar` | `${K}En`]: string;
};

/**
 * What goes out when no rule matches, or a rule leaves a field empty in both
 * languages. The sentences the survey carried before an admin could change
 * them, so the switch works before anybody has written a word.
 */
export const DEFAULT_WORDING: Record<WordingLocale, Wording> = {
  en: {
    question: 'How did we do?',
    intro: 'Your ticket is resolved.',
    subtitle: 'It takes ten seconds to tell us how it went.',
    button: 'Send',
    commentPrompt: 'Anything you would like to add? (optional)',
    thanks: 'Thank you. Your feedback has been passed to the team.',
  },
  ar: {
    question: 'كيف كانت تجربة حضرتك مع الدعم؟',
    intro: 'تم حل طلب حضرتك.',
    subtitle: 'رأي حضرتك يستغرق عشر ثوانٍ فقط.',
    button: 'إرسال',
    commentPrompt: 'هل هناك ما تودّ حضرتك إضافته؟ (اختياري)',
    thanks: 'شكرًا لحضرتك. تم إرسال رأيك إلى الفريق.',
  },
};

export const EMPTY_WORDING_PAIR: WordingPair = {
  questionAr: '',
  questionEn: '',
  introAr: '',
  introEn: '',
  subtitleAr: '',
  subtitleEn: '',
  buttonAr: '',
  buttonEn: '',
  commentPromptAr: '',
  commentPromptEn: '',
  thanksAr: '',
  thanksEn: '',
};

/** The column name a field's string sits in, for one language. */
export function wordingColumn(field: WordingField, locale: WordingLocale): keyof WordingPair {
  return `${field}${locale === 'ar' ? 'Ar' : 'En'}` as keyof WordingPair;
}

/**
 * A pair built one string at a time — from the built-in wording, a rule row
 * or a submitted form — so the loop over fields and languages, and the cast
 * that has to come with it, are written once.
 */
export function toWordingPair(
  value: (field: WordingField, locale: WordingLocale) => string,
): WordingPair {
  const pair = {} as WordingPair;
  for (const field of WORDING_FIELDS) {
    for (const locale of ['ar', 'en'] as const) {
      pair[wordingColumn(field, locale)] = value(field, locale);
    }
  }
  return pair;
}

/** Code points, which is what Meta counts. */
export function wordingLength(value: string): number {
  return [...value].length;
}

/** Meta refuses a link in a card; so does this, in the same spelling everywhere. */
export function carriesUrl(value: string): boolean {
  return /https?:\/\/|www\./i.test(value);
}

/**
 * What is wrong with one field in one language, or null. An empty string is
 * never wrong here — it falls back — except on the question, which the save
 * action requires in at least one language, since the question is the survey.
 */
export function wordingProblem(field: WordingField, value: string): string | null {
  const limit = WORDING_LIMITS[field];
  const trimmed = value.trim();
  if (!trimmed) return null;
  const length = wordingLength(trimmed);
  if (limit.max !== null && length > limit.max) {
    return `${limit.label} can be at most ${limit.max} characters`;
  }
  if (limit.maxBytes !== null && new TextEncoder().encode(trimmed).length > limit.maxBytes) {
    return `${limit.label} is too long to send on Instagram, which counts an emoji or an Arabic letter as more than one character`;
  }
  if (limit.min !== null && length < limit.min) {
    return `${limit.label} has to be at least ${limit.min} characters`;
  }
  if (limit.noUrl && carriesUrl(trimmed)) return `${limit.label} cannot carry a link`;
  return null;
}

/** Every problem in a pair, worded with the language, for the save action to refuse with. */
export function wordingProblems(pair: WordingPair): string[] {
  const problems: string[] = [];
  if (!pair.questionAr.trim() && !pair.questionEn.trim()) {
    problems.push('Write the question in at least one language');
  }
  for (const field of WORDING_FIELDS) {
    for (const locale of ['ar', 'en'] as const) {
      const problem = wordingProblem(field, pair[wordingColumn(field, locale)]);
      if (problem) problems.push(`${problem} (${locale === 'ar' ? 'Arabic' : 'English'})`);
    }
  }
  return problems;
}

/**
 * The strings a customer reading `locale` gets: each field from that language,
 * else from the other, else the built-in — per field, so a rule that only
 * reworded the question in Arabic keeps the built-in thanks in both.
 */
export function resolveWording(pair: WordingPair | null, locale: WordingLocale): Wording {
  const other: WordingLocale = locale === 'ar' ? 'en' : 'ar';
  const out = {} as Wording;
  for (const field of WORDING_FIELDS) {
    const own = pair?.[wordingColumn(field, locale)].trim() ?? '';
    const fallback = pair?.[wordingColumn(field, other)].trim() ?? '';
    out[field] = own || fallback || DEFAULT_WORDING[locale][field];
  }
  return out;
}

export type WordingScope = { groupId: string | null; channel: string | null };

/**
 * The rule for a ticket: the most specific active one, a channel beating a
 * group and both beating either — the scoring `lib/auto-response/resolve.ts`
 * gives for the out-of-hours reply, and for the reasons given there. Two
 * rules can never tie: a score names a scope, and `csat_rules_scope_key`
 * allows one row per scope.
 */
export function pickWordingRule<R extends WordingScope & { isActive: boolean }>(
  rules: R[],
  scope: { groupId: string | null; channel: string },
): R | null {
  let best: R | null = null;
  let bestScore = -1;
  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.groupId !== null && rule.groupId !== scope.groupId) continue;
    if (rule.channel !== null && rule.channel !== scope.channel) continue;
    const score = (rule.channel !== null ? 2 : 0) + (rule.groupId !== null ? 1 : 0);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return best;
}

/** The five ratings, worst first, as the help centre words them. */
export function ratingLabels(locale: Locale): [string, string, string, string, string] {
  return [
    t(locale, 'csatRating1'),
    t(locale, 'csatRating2'),
    t(locale, 'csatRating3'),
    t(locale, 'csatRating4'),
    t(locale, 'csatRating5'),
  ];
}

/** The link that lands on the page with that rating already chosen. */
export function ratingUrl(surveyUrl: string, rating: number): string {
  return `${surveyUrl}${surveyUrl.includes('?') ? '&' : '?'}rating=${rating}`;
}

/** `?rating=n` read back off one of those links, or null for a bare link or anything else. */
export function preselectedRating(raw: string | string[] | undefined): number | null {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

/**
 * The survey as a plain message — web chat's text under its card, and the
 * prompt Meta's rating buttons sit under: the first line, the question, and
 * the link where the delivery carries one.
 */
export function surveyText(wording: Wording, url: string | null): string {
  return [wording.intro, wording.question, url].filter(Boolean).join('\n');
}
