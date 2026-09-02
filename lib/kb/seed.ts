/**
 * The search terms a ticket suggests about itself.
 *
 * The composer's knowledge panel wants to show something useful before the
 * agent types, and the only text available to seed it with is the customer's
 * own. Handing that text to the search verbatim does not work: the vector is
 * built with the `simple` configuration and `websearch_to_tsquery` ANDs its
 * terms, so a forty-word message becomes a forty-way conjunction that matches
 * no article ever written. Reducing it to a handful of content words and
 * OR-ing them is what turns "where is my parcel, I ordered on Sunday and the
 * app still says nothing" into a query the index can answer.
 *
 * Everything here is pure and script-agnostic on purpose — it runs on the
 * server inside the ticket page's render, and it is the piece most likely to be
 * wrong in a way only a test catches.
 */

/**
 * Arabic diacritics and the tatweel elongation dash.
 *
 * Both are decoration a writer may or may not use, and neither appears in the
 * index — `to_tsvector('simple', ...)` does no folding of any kind — so a term
 * carrying one cannot match the article it came from.
 *
 * Only these. The other obvious normalisations (أ إ آ to ا, ى to ي, ة to ه) are
 * deliberately *not* applied: the article side is not normalised either, so
 * folding one side alone turns a match into a miss.
 */
const TASHKEEL = /[ً-ْٰٖ-ٟۖ-ۭـ]/g;
/**
 * Arabic diacritics and tatweel, stripped, exported for the one other module
 * that has to make the same decision.
 *
 * `lib/categorise/normalise.ts` matches message text against patterns and has to
 * strip these for the same reason this file does — a diacritic is not a letter,
 * so anything splitting on non-letters tears الشِّحنة into fragments. Shared
 * rather than copied so the two cannot end up disagreeing about which marks
 * count as a diacritic.
 */
export function stripTashkeel(text: string): string {
  return text.replace(TASHKEEL, '');
}

/** Anything that is not a letter or a digit separates one token from the next. */
const SEPARATOR = /[^\p{L}\p{N}]+/u;

const HAS_DIGIT = /\p{N}/u;

/**
 * Below this, a token is a particle rather than a subject.
 *
 * One threshold for both scripts. Arabic content words run to three letters and
 * up (طلب, رقم, شحن) while its one- and two-letter words are almost all
 * prepositions and pronouns, so the same number that keeps "cod" and drops "to"
 * keeps "طلب" and drops "من".
 */
const MIN_LENGTH = 3;

/**
 * How many terms reach the query.
 *
 * A disjunction of six already matches most of a 112-article knowledge base on
 * at least one term; adding more widens the net without changing the top of the
 * ranking, and every extra term is another chance to rank an article highly for
 * a word the customer used in passing.
 */
const MAX_TERMS = 6;

/**
 * Below this, there is nothing to suggest from.
 *
 * A single term is not a topic — "شحنة" alone matches nearly every article we
 * have, and a panel confidently offering three of them is worse than a panel
 * offering none, because the agent has to read them to find that out.
 */
const MIN_TERMS = 2;

/**
 * Words that appear in every ticket and every article, so they discriminate
 * between none of them.
 *
 * Deliberately hand-written and short rather than a stopword package. Postgres
 * has no Arabic configuration to borrow a list from, the Egyptian colloquial
 * that arrives on WhatsApp ("ازاي", "امتى", "عايز") is in no standard list
 * anyway, and "shipblu" is a stopword *here* specifically — it is in the
 * signature of half the articles.
 */
const STOPWORDS = new Set([
  // English
  'the',
  'and',
  'for',
  'you',
  'your',
  'yours',
  'are',
  'was',
  'were',
  'but',
  'not',
  'with',
  'this',
  'that',
  'these',
  'those',
  'have',
  'has',
  'had',
  'from',
  'can',
  'cant',
  'cannot',
  'will',
  'would',
  'could',
  'should',
  'please',
  'thanks',
  'thank',
  'hello',
  'dear',
  'been',
  'they',
  'them',
  'their',
  'there',
  'what',
  'when',
  'where',
  'why',
  'how',
  'who',
  'all',
  'any',
  'our',
  'ours',
  'out',
  'its',
  'about',
  'just',
  'need',
  'want',
  'know',
  'get',
  'got',
  'did',
  'does',
  'done',
  'still',
  'very',
  'also',
  'into',
  'than',
  'then',
  'some',
  'sir',
  'madam',
  'regards',
  'kindly',
  'hi',
  'me',
  'my',
  'it',
  'is',
  'to',
  'of',
  'in',
  'on',
  'at',
  'shipblu',
  'shib',
  'blu',
  // Arabic — Modern Standard
  'من',
  'في',
  'على',
  'عن',
  'إلى',
  'الى',
  'مع',
  'هذا',
  'هذه',
  'ذلك',
  'التي',
  'الذي',
  'كان',
  'كانت',
  'يكون',
  'لا',
  'لم',
  'لن',
  'هل',
  'أن',
  'ان',
  'إن',
  'أو',
  'او',
  'ثم',
  'قد',
  'كل',
  'بعد',
  'قبل',
  'عند',
  'أنا',
  'انا',
  'أنت',
  'انت',
  'هو',
  'هي',
  'هم',
  'نحن',
  'لكن',
  'حتى',
  'شكرا',
  'شكراً',
  'السلام',
  'عليكم',
  'مرحبا',
  'أهلا',
  'اهلا',
  'ياريت',
  'يا',
  'لو',
  'سمحت',
  'رجاء',
  'برجاء',
  'الرجاء',
  'تحياتي',
  'شيب',
  'بلو',
  // Arabic — the Egyptian colloquial the chat channels actually carry
  'ايه',
  'إيه',
  'ازاي',
  'إزاي',
  'ليه',
  'فين',
  'امتى',
  'إمتى',
  'بس',
  'كده',
  'دي',
  'ده',
  'دا',
  'علشان',
  'عشان',
  'ممكن',
  'عايز',
  'عاوز',
  'محتاج',
  'بتاع',
  'دلوقتي',
  'خالص',
  'اوي',
  'أوي',
  'برضو',
  'برضه',
  'مش',
  'انه',
  'إنه',
]);

/**
 * Content words from a ticket, most-recent-message first.
 *
 * The latest inbound message wins over the subject because on every chat
 * channel the subject is derived from the *first* message and is stale by the
 * twentieth — "hello" is what a WhatsApp ticket is called and never what it is
 * about. The subject is the fallback rather than an equal contributor for the
 * mirror-image reason: on email it is the topic, but it arrives wrapped in
 * "Re: Re: Fwd:" and merging the two lets the noise from one channel into the
 * other.
 *
 * Returns an empty array rather than a thin guess. A caller that gets nothing
 * shows nothing, which is the same thing the help centre's blocks do when they
 * have nothing to say.
 */
export function seedTerms(
  subject: string | null | undefined,
  latestInbound: string | null | undefined,
): string[] {
  const fromMessage = contentWords(latestInbound);
  if (fromMessage.length >= MIN_TERMS) return fromMessage;

  const fromSubject = contentWords(subject);
  if (fromSubject.length >= MIN_TERMS) return fromSubject;

  return [];
}

function contentWords(text: string | null | undefined): string[] {
  if (!text) return [];

  const seen = new Set<string>();

  // Stripped before splitting, and the order is load-bearing: a diacritic is
  // not a letter, so `SEPARATOR` treats one as a word boundary and tears
  // الشِّحنة into two fragments that match nothing. Removing them first cannot
  // join two words by mistake, because a mark only ever sits on a letter.
  const cleaned = text.normalize('NFKC').toLowerCase().replace(TASHKEEL, '');

  for (const token of cleaned.split(SEPARATOR)) {
    // A token carrying a digit is a reference, not a topic — a tracking number,
    // an order id, a phone number, "24h". None of them appear in an article
    // body, so each one that reaches the query is a wasted slot in a
    // disjunction that only has six.
    if (HAS_DIGIT.test(token)) continue;
    if (token.length < MIN_LENGTH) continue;
    if (STOPWORDS.has(token)) continue;

    seen.add(token);
    if (seen.size === MAX_TERMS) break;
  }

  return [...seen];
}
