import { hasEnoughContent, normaliseForMatch } from './normalise';
import { ANCHORED_GRADE, PATTERNS, type PatternRule, disabledRuleKeys, phraseIndex } from './rules';
import { SPAM_KEY, UNCLASSIFIED_KEY, allCategories } from './taxonomy';

/**
 * Turning one message into the categories it is evidence for.
 *
 * Pure: no database, no `env()`, no clock. Everything about what a message means
 * is decided here and in `rules.ts`, so the whole decision surface is reachable
 * from Vitest — which matters more than usual because Vitest runs with no
 * database, so this is the *only* layer of this feature that the pre-push loop
 * can check at all.
 */

export type HitLayer = 'phrase' | 'keyword' | 'fallback';

export type CategoryHit = {
  /** A `ticket_categories.key`. */
  key: string;
  /** The evidence grade, 0..1. See `rules.ts` — not a probability. */
  confidence: number;
  /** Which rule earned it, or null for the fallback. */
  ruleKey: string | null;
  layer: HitLayer;
  /** What the matcher actually saw, for the sidebar and for tuning. */
  evidence: Record<string, unknown>;
};

export type DetectInput = {
  bodyText: string;
};

/**
 * How many categories one message may contribute.
 *
 * Four. A message that appears to be about more than four things is a forwarded
 * thread or somebody listing every problem they have ever had, and in both cases
 * the labels stop describing and start listing.
 */
export const MAX_CATEGORIES_PER_MESSAGE = 4;

/**
 * Nothing inferred from free text ever claims certainty.
 *
 * A structured field can be 1.0. A reading of what somebody wrote cannot, so
 * however many rules agree, the answer stops short of it.
 */
export const INFERENCE_CEILING = 0.95;

/**
 * The ceiling on a pile of single content words, and it sits **below**
 * `AUTO_APPLY_MIN` on purpose.
 *
 * Three 0.55 hits noisy-OR to 0.909 and four to 0.959. Without this they would
 * be auto-applied on the strength of three single words, which is exactly the
 * over-detection this feature cannot afford — and it is what the one ceiling
 * this file used to carry failed to prevent, because 0.95 is above the
 * auto-apply line rather than below it. Capping weak accumulation here leaves
 * those hits in the review queue, where a keyword pile belongs: it is a better
 * question, not an answer.
 *
 * Two *anchored* rules agreeing are a different claim and are not capped here —
 * see `combine()`.
 */
export const KEYWORD_CEILING = 0.85;

/**
 * The two thresholds the human-in-the-loop design turns on.
 *
 * Deliberately two rather than one, and both sit on the seam between *kinds* of
 * evidence rather than on a round number picked to hit a coverage target:
 *
 * - At or above `AUTO_APPLY_MIN` the whole message was a known phrase, or
 *   several strong patterns agreed. Applied without asking.
 * - Down to `RECORD_MIN` it is applied but marked `suggested`, which puts it in
 *   the review queue and gives an agent one click to confirm or reject.
 * - Below `RECORD_MIN` nothing is written. A table full of things we do not
 *   believe is a review queue nobody ever finishes.
 *
 * Both are overridable from the environment so recalibration is a dashboard
 * change rather than a deploy — see `thresholds()`.
 */
export const AUTO_APPLY_MIN = 0.9;
export const RECORD_MIN = 0.35;

/**
 * The thresholds actually in force, read straight from `process.env`.
 *
 * Not through `env()`, for the reason `lib/shipments/detect.ts` documents: it
 * validates the whole schema and this module is reachable from the ingest path
 * and from a page render, so an unrelated missing variable would break
 * categorisation. A value that will not parse falls back to the constant rather
 * than throwing — a mistyped threshold must not stop tickets being categorised.
 *
 * One function, so the detector, the writer and the review queue cannot end up
 * disagreeing about what "high confidence" means. That is the same failure mode
 * AGENTS.md documents for the two profile-refresh paths, applied to a number.
 */
export function thresholds(): { autoApply: number; record: number } {
  return {
    autoApply: envNumber('CATEGORISE_AUTO_MIN', AUTO_APPLY_MIN),
    record: envNumber('CATEGORISE_RECORD_MIN', RECORD_MIN),
  };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    console.warn(`[categorise] ${name}=${raw} is not a number in 0..1; using ${fallback}`);
    return fallback;
  }
  return value;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

/**
 * `1 − Π(1 − wᵢ)` — the standard way to combine independent weak evidence.
 *
 * Which ceiling applies is decided by the **strongest** rule that contributed,
 * not by how many did, and that is the whole of the design here. Accumulation
 * sharpens confidence within a kind of evidence; it must not promote evidence
 * into a kind it never was.
 *
 * - Every contributor a single content word (< `ANCHORED_GRADE`) → capped at
 *   `KEYWORD_CEILING`, below the auto line. Two 0.55s make 0.7975 and three
 *   make 0.909, which without the cap would be auto-applied on three words.
 * - At least one anchored rule → capped only at `INFERENCE_CEILING`. Two
 *   anchored patterns agreeing reach 0.91 and may be applied without asking,
 *   which is the "several strong patterns agreed" case `AUTO_APPLY_MIN`'s
 *   docstring names. A 0.7 with a 0.55 still makes 0.865 and is suggested.
 */
export function combine(grades: readonly number[]): number {
  const product = grades.reduce((acc, grade) => acc * (1 - grade), 1);
  const strongest = Math.max(...grades);
  const ceiling = strongest < ANCHORED_GRADE ? KEYWORD_CEILING : INFERENCE_CEILING;
  return Math.min(1 - product, ceiling);
}

function matchingPatterns(normalised: string, disabled: ReadonlySet<string>): PatternRule[] {
  const hits: PatternRule[] = [];
  for (const rule of PATTERNS) {
    if (disabled.has(rule.key)) continue;
    // One hit per rule per message, deliberately. Counting each occurrence would
    // let a word repeated fifty times drive the combination to 1.0 and
    // impersonate a structured field.
    if (rule.pattern.test(normalised)) hits.push(rule);
  }
  return hits;
}

/**
 * The categories one message is evidence for, best first.
 *
 * The cascade, in order, and each step's reason:
 *
 * 1. **The whole message is a known phrase** → 0.90, before anything else. An
 *    exact match is enough content by definition, which is why it is tested
 *    ahead of the floor below.
 * 2. **Nothing to classify.** An *unrecognised* message below the content floor
 *    — a bare `؟`, an emoji, an image with no caption — returns no hits at all
 *    rather than a guess. The caller writes nothing.
 * 3. **Spam is exclusive.** If a spam rule fires, that is the only answer. A
 *    promotional message containing `توصيل` would otherwise be filed as a
 *    delivery question and move the driver report; another merchant's
 *    autoresponder would be filed as a customer asking for help.
 * 4. **Anchored patterns** → 0.70 / 0.55, combined per category and capped by
 *    `combine()`, which decides the ceiling from the strongest rule that
 *    contributed rather than from how many did.
 * 5. **Free text and no rule matched** → `meta.unclassified` at 0, which is a
 *    countable outcome rather than an absence. It is the only category here
 *    meant to shrink.
 *
 * Step 1 is equality against the whole message, so there is no surrounding
 * sentence to change the meaning. Never 1.00 even so: somebody typing a menu
 * label must not outrank a structured field.
 */
export function detectCategories(input: DetectInput): CategoryHit[] {
  const normalised = normaliseForMatch(input.bodyText);
  const disabled = disabledRuleKeys();

  // The phrase index is consulted **before** the content floor, and the order is
  // the point. A message that exactly equals a phrase somebody wrote down is
  // enough content by definition — the floor exists to refuse *unrecognised*
  // short text, a bare `؟` or an emoji. Checking the floor first silently
  // killed `ok` and `hi`, which are two characters each: the rules were in the
  // table, scored zero forever, and read in the tuning report as rules nobody
  // had checked rather than rules that could not fire.
  const phrase = phraseIndex().get(normalised);
  if (phrase && !disabled.has(phrase.key)) {
    return [
      {
        key: phrase.category,
        confidence: 0.9,
        ruleKey: phrase.key,
        layer: 'phrase',
        evidence: { phrase: normalised },
      },
    ];
  }

  if (!hasEnoughContent(normalised)) return [];

  const matched = matchingPatterns(normalised, disabled);

  const spam = matched.filter((rule) => rule.category === SPAM_KEY);
  if (spam.length > 0) {
    return [
      {
        key: SPAM_KEY,
        confidence: combine(spam.map((rule) => rule.grade)),
        ruleKey: spam[0]!.key,
        layer: 'keyword',
        evidence: { rules: spam.map((rule) => rule.key) },
      },
    ];
  }

  if (matched.length === 0) {
    return [
      {
        key: UNCLASSIFIED_KEY,
        confidence: 0,
        ruleKey: null,
        layer: 'fallback',
        evidence: {},
      },
    ];
  }

  const byCategory = new Map<string, PatternRule[]>();
  for (const rule of matched) {
    const bucket = byCategory.get(rule.category);
    if (bucket) bucket.push(rule);
    else byCategory.set(rule.category, [rule]);
  }

  const hits: CategoryHit[] = [];
  for (const [key, rules] of byCategory) {
    const confidence = combine(rules.map((rule) => rule.grade));
    if (confidence < thresholds().record) continue;
    hits.push({
      key,
      confidence,
      ruleKey: rules[0]!.key,
      layer: 'keyword',
      evidence: { rules: rules.map((rule) => rule.key) },
    });
  }

  if (hits.length === 0) {
    return [
      { key: UNCLASSIFIED_KEY, confidence: 0, ruleKey: null, layer: 'fallback', evidence: {} },
    ];
  }

  return rankHits(hits).slice(0, MAX_CATEGORIES_PER_MESSAGE);
}

/**
 * The order hits are considered in, and the order the primary is picked from.
 *
 * A ladder rather than a fixed precedence list, because a fixed list is what
 * made an earlier version of this collapse `delivery.eta_request` from 2,718
 * conversations to 18 — whichever entry sat higher swallowed everything it
 * co-occurred with, and the report then said that nobody ever asks when their
 * parcel is coming.
 *
 * 1. **Confidence**, descending. Better evidence wins.
 * 2. **Severity.** A parcel marked delivered that never arrived beats an address
 *    confirmation on the same ticket, at equal confidence, because one of them is
 *    what the customer actually wants somebody to do something about.
 * 3. **Position** in the taxonomy, then the key — so the answer is fully
 *    deterministic and a test can assert it is stable across runs.
 */
export function rankHits(hits: readonly CategoryHit[]): CategoryHit[] {
  const meta = categoryMeta();

  return [...hits].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;

    const severityA = SEVERITY_RANK[meta.get(a.key)?.severity ?? 'normal'] ?? 1;
    const severityB = SEVERITY_RANK[meta.get(b.key)?.severity ?? 'normal'] ?? 1;
    if (severityA !== severityB) return severityA - severityB;

    const positionA = meta.get(a.key)?.position ?? Number.MAX_SAFE_INTEGER;
    const positionB = meta.get(b.key)?.position ?? Number.MAX_SAFE_INTEGER;
    if (positionA !== positionB) return positionA - positionB;

    return a.key.localeCompare(b.key);
  });
}

type Meta = { position: number; severity: 'high' | 'normal' | 'low' };
let metaCache: ReadonlyMap<string, Meta> | null = null;

function categoryMeta(): ReadonlyMap<string, Meta> {
  if (metaCache) return metaCache;
  const map = new Map<string, Meta>();
  for (const category of allCategories()) {
    map.set(category.key, {
      position: category.position,
      severity: category.severity ?? 'normal',
    });
  }
  metaCache = map;
  return map;
}

/**
 * What should happen to a hit: apply it, suggest it, or write nothing.
 *
 * Takes the hit rather than a bare number because the fallback is the exception
 * that would otherwise be got wrong. `meta.unclassified` carries confidence 0 —
 * it is an admission, not a guess — and a plain numeric threshold would discard
 * exactly the row the review queue is built on. So the fallback is always
 * written, always as `suggested`.
 */
export function bandFor(hit: CategoryHit): 'auto' | 'suggested' | 'ignored' {
  if (hit.layer === 'fallback') return 'suggested';

  const { autoApply, record } = thresholds();
  if (hit.confidence >= autoApply) return 'auto';
  if (hit.confidence >= record) return 'suggested';
  return 'ignored';
}
