import { describe, expect, it } from 'vitest';
import { emptyBucket } from './rollup';
import {
  categoryCoverage,
  ratingCounts,
  ratingShares,
  responseRate,
  responsesHint,
  surveyedRate,
  uncategorised,
  unsplitAnswers,
  windowDays,
  type Totals,
} from './queries';

/**
 * The satisfaction figures every report derives from the rollup's sums, so
 * "response rate" and "% positive" are each defined once.
 */

const row = (counts: Partial<Totals>): Totals => ({ ...emptyBucket(), ...counts });

// Answers as the rollup writes them since survey counts were kept: the count
// and the distribution agree, all of them 4s here.
const answers = (count: number): Partial<Totals> => ({
  csatResponseCount: count,
  csatRating4: count,
  csatRatingSum: 4 * count,
});

// A day rolled up before survey counts were kept: its answers' count and sum,
// no split, and a send count of 0 that means "not counted".
const before = (count: number): Partial<Totals> => ({
  csatResponseCount: count,
  csatRatingSum: 4 * count,
});

describe('responseRate', () => {
  it('divides the answers in the window by the surveys sent in it', () => {
    expect(responseRate(row({ ...answers(3), csatSentCount: 12 }))).toBe(25);
  });

  it('reads nothing sent as no rate, not as zero', () => {
    expect(responseRate(row({ csatSentCount: 0 }))).toBeNull();
    expect(responseRate(row({ ...answers(2), csatSentCount: 0 }))).toBeNull();
  });

  it('says so when a window caught the answers to an earlier one', () => {
    // A rate, not a cohort: a link answered after the week it went out
    // counts in the week it was answered, and is not clipped to 100.
    expect(responseRate(row({ ...answers(6), csatSentCount: 4 }))).toBe(150);
  });

  it('leaves out answers from days rolled up before their sends were counted', () => {
    // 40 answers on old days and 10 on new ones, over the 20 sends the new
    // days counted: 50%, not 250%.
    const window = row({ ...answers(10), csatSentCount: 20 });
    window.csatResponseCount += before(40).csatResponseCount!;
    expect(responseRate(window)).toBe(50);
  });
});

describe('responsesHint', () => {
  it('says how many answers, and what share of the sends they are', () => {
    expect(responsesHint(row({ ...answers(3), csatSentCount: 12 }))).toBe(
      '3 responses · 25% of 12 sent',
    );
    expect(responsesHint(row({ ...answers(1), csatSentCount: 1 }))).toBe(
      '1 response · 100% of 1 sent',
    );
  });

  it('leaves the rate off when nothing was sent, rather than calling it 0%', () => {
    expect(responsesHint(row({ ...answers(2), csatSentCount: 0 }))).toBe('2 responses');
  });

  it('leaves the rate off when it would be the rate of fewer answers than it names', () => {
    const window = row({ ...answers(10), csatSentCount: 20 });
    window.csatResponseCount += before(40).csatResponseCount!;
    expect(responsesHint(window)).toBe('50 responses');
  });
});

describe('unsplitAnswers', () => {
  it('names the days whose answers the average counts and the distribution does not', () => {
    expect(
      unsplitAnswers([
        { ...row(before(3)), day: '2026-08-30' },
        { ...row(answers(5)), day: '2026-10-01' },
        { ...row({ ...answers(2), csatResponseCount: 4 }), day: '2026-08-31' },
      ]),
    ).toEqual({ answers: 5, days: ['2026-08-30', '2026-08-31'] });
  });

  it('finds none where every day kept its split', () => {
    expect(unsplitAnswers([{ ...row(answers(5)), day: '2026-10-01' }])).toEqual({
      answers: 0,
      days: [],
    });
  });
});

describe('surveyedRate', () => {
  it('divides the surveys sent by the tickets resolved', () => {
    expect(surveyedRate(row({ csatSentCount: 41, ticketsResolved: 66 }))).toBe(62);
    expect(surveyedRate(row({ csatSentCount: 0, ticketsResolved: 0 }))).toBeNull();
  });
});

describe('ratingShares', () => {
  it('reads 4–5 as positive and 1–2 as negative, out of the distribution', () => {
    const answers = row({
      csatRating1: 2,
      csatRating2: 1,
      csatRating3: 1,
      csatRating4: 2,
      csatRating5: 4,
      csatResponseCount: 10,
    });
    expect(ratingCounts(answers)).toEqual([2, 1, 1, 2, 4]);
    expect(ratingShares(answers)).toEqual({ positive: 60, negative: 30 });
  });

  it('has nothing to say about a window with no distribution', () => {
    // A day rolled up before the distribution existed still has its average.
    expect(ratingShares(row({ csatResponseCount: 3, csatRatingSum: 12 }))).toEqual({
      positive: null,
      negative: null,
    });
  });

  it('shows a split week as two ends, not as its average of 3', () => {
    // An average of 3.0 over a week of ones and fives is the case the
    // distribution exists for: half negative, half positive, none neutral.
    expect(ratingShares(row({ csatRating1: 5, csatRating5: 5 }))).toEqual({
      positive: 50,
      negative: 50,
    });
  });
});

describe('windowDays', () => {
  it('lists every day of the window, both ends included', () => {
    expect(windowDays({ from: '2026-10-28', to: '2026-11-02' })).toEqual([
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  it('steps by calendar day, so a clock change neither loses nor doubles one', () => {
    // Cairo's clocks go back on the night of 29 October: a 25-hour day, still one day.
    expect(windowDays({ from: '2026-10-29', to: '2026-10-31' })).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
    ]);
  });

  it('has no days in a window that ends before it starts', () => {
    expect(windowDays({ from: '2026-10-13', to: '2026-10-12' })).toEqual([]);
  });
});

describe('uncategorised', () => {
  // Every column set, each to a different value, so a column subtracted from
  // the wrong one, or left out, cannot pass.
  const total = Object.fromEntries(
    Object.keys(emptyBucket()).map((key, index) => [key, 1000 + 10 * index]),
  ) as Totals;
  const each = (value: number) =>
    Object.fromEntries(Object.keys(emptyBucket()).map((key) => [key, value])) as Totals;

  it('is the totals less every category, column by column', () => {
    const rest = uncategorised(total, [each(3), each(4)]);
    for (const key of Object.keys(emptyBucket()) as (keyof Totals)[]) {
      expect(rest[key], key).toBe(total[key] - 7);
    }
  });

  it('is the whole of the totals when nothing has a category', () => {
    expect(uncategorised(total, [])).toEqual(total);
  });

  it('leaves a figure past the totals negative, rather than hiding it as nothing', () => {
    // `reconciles()` refuses a day whose categories sum past its totals, so this
    // is a bug if it is ever seen — and seen is the point.
    expect(
      uncategorised(row({ ticketsCreated: 2, csatRating5: 1 }), [
        row({ ticketsCreated: 3, csatRating5: 1 }),
      ]),
    ).toMatchObject({ ticketsCreated: -1, csatRating5: 0 });
  });
});

describe('categoryCoverage', () => {
  it('says nothing has a category when no category slice reaches the window', () => {
    expect(categoryCoverage(0, null, '2026-10-01')).toEqual({ kind: 'never' });
  });

  it('says the window has none when the category slices are all before it', () => {
    expect(categoryCoverage(0, '2026-09-01', '2026-10-01')).toEqual({ kind: 'none-here' });
  });

  it('names the day the category slices start when that is inside the window', () => {
    expect(categoryCoverage(2, '2026-10-12', '2026-10-01')).toEqual({
      kind: 'starts',
      on: '2026-10-12',
    });
  });

  it('has nothing to say when they cover the window from its first day', () => {
    expect(categoryCoverage(2, '2026-10-01', '2026-10-01')).toEqual({ kind: 'whole' });
    expect(categoryCoverage(2, '2026-09-01', '2026-10-01')).toEqual({ kind: 'whole' });
  });
});
