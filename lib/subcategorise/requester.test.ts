import { describe, expect, it } from 'vitest';
import { type RequesterFacts, requesterKindFrom } from './requester';

/**
 * All eight combinations, because the interesting cases are the ones a
 * three-branch function makes look obvious.
 */
const facts = (
  isShipper: boolean,
  isRecipient: boolean,
  hasShippingAccount: boolean,
): RequesterFacts => ({ isShipper, isRecipient, hasShippingAccount });

describe('requesterKindFrom', () => {
  it.each([
    // shipper, recipient, account, expected
    [false, false, false, null],
    [false, false, true, 'merchant'],
    [false, true, false, 'recipient'],
    [false, true, true, 'merchant'],
    [true, false, false, 'merchant'],
    [true, false, true, 'merchant'],
    [true, true, false, 'merchant'],
    [true, true, true, 'merchant'],
  ] as const)(
    'shipper=%s recipient=%s account=%s → %s',
    (isShipper, isRecipient, hasAccount, expected) => {
      expect(requesterKindFrom(facts(isShipper, isRecipient, hasAccount))).toBe(expected);
    },
  );

  it('reads both flags as a merchant, which is the common case rather than a conflict', () => {
    // db/schema/customers.ts: "a merchant who also receives returns is both, and
    // that is the common case for anyone who ships at all". Resolving this to
    // null would leave the majority of merchants unclassified.
    expect(requesterKindFrom(facts(true, true, false))).toBe('merchant');
  });

  it('leaves a contact with no records at all unestablished, rather than a prospect', () => {
    // The one that matters. Role flags are maintained additively — set when
    // provable, never cleared — so no flag means no evidence, not evidence of
    // no relationship. A recipient whose parcel has not synced looks identical
    // to a stranger, and filing them as a sales lead would put a number on the
    // pipeline report that nobody measured.
    expect(requesterKindFrom(facts(false, false, false))).toBeNull();
  });
});
