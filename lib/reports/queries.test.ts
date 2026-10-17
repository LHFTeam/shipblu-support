import { describe, expect, it } from 'vitest';
import { emptyBucket } from './rollup';
import { ratingCounts, ratingShares, responseRate, surveyedRate, type Totals } from './queries';

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

  it('keeps a split three-way scale apart rather than calling a 3 either', () => {
    // An average of 3.0 over a week of ones and fives is the case the
    // distribution exists for: half negative, half positive, none neutral.
    expect(ratingShares(row({ csatRating1: 5, csatRating5: 5 }))).toEqual({
      positive: 50,
      negative: 50,
    });
  });
});
