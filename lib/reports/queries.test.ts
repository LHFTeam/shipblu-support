import { describe, expect, it } from 'vitest';
import { emptyBucket } from './rollup';
import {
  ratingCounts,
  ratingShares,
  responseRate,
  responsesHint,
  surveyedRate,
  windowDays,
  type Totals,
} from './queries';

/**
 * The satisfaction figures every report derives from the rollup's sums, so
 * "response rate" and "% positive" are each defined once.
 */

const row = (counts: Partial<Totals>): Totals => ({ ...emptyBucket(), ...counts });

describe('responseRate', () => {
  it('divides the answers in the window by the surveys sent in it', () => {
    expect(responseRate(row({ csatResponseCount: 3, csatSentCount: 12 }))).toBe(25);
  });

  it('reads nothing sent as no rate, not as zero', () => {
    expect(responseRate(row({ csatResponseCount: 0, csatSentCount: 0 }))).toBeNull();
    expect(responseRate(row({ csatResponseCount: 2, csatSentCount: 0 }))).toBeNull();
  });

  it('says so when a window caught the answers to an earlier one', () => {
    // A rate, not a cohort: a link answered after the week it went out
    // counts in the week it was answered, and is not clipped to 100.
    expect(responseRate(row({ csatResponseCount: 6, csatSentCount: 4 }))).toBe(150);
  });
});

describe('responsesHint', () => {
  it('says how many answers, and what share of the sends they are', () => {
    expect(responsesHint(row({ csatResponseCount: 3, csatSentCount: 12 }))).toBe(
      '3 responses · 25% of 12 sent',
    );
    expect(responsesHint(row({ csatResponseCount: 1, csatSentCount: 1 }))).toBe(
      '1 response · 100% of 1 sent',
    );
  });

  it('leaves the rate off when nothing was sent, rather than calling it 0%', () => {
    expect(responsesHint(row({ csatResponseCount: 2, csatSentCount: 0 }))).toBe('2 responses');
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
