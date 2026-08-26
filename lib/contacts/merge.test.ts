import { describe, expect, it } from 'vitest';
import { reconcileContact, refuseMerge, type MergeSide } from './merge';

function side(overrides: Partial<MergeSide> = {}): MergeSide {
  return {
    id: 'contact-1',
    name: null,
    primaryEmail: null,
    primaryPhone: null,
    avatarPath: null,
    companyId: null,
    timezone: null,
    locale: 'en',
    customFields: {},
    isBlocked: false,
    isShipper: false,
    isRecipient: false,
    deletedAt: null,
    mergedIntoContactId: null,
    ...overrides,
  };
}

const SURVIVOR = side({ id: 'survivor' });
const LOSER = side({ id: 'loser' });

describe('refuseMerge', () => {
  it('allows an ordinary pair', () => {
    expect(refuseMerge(SURVIVOR, LOSER)).toBeNull();
  });

  it('refuses a contact that is not there', () => {
    expect(refuseMerge(undefined, LOSER)).toBe('not_found');
    expect(refuseMerge(SURVIVOR, null)).toBe('not_found');
  });

  it('refuses merging a contact into itself', () => {
    expect(refuseMerge(SURVIVOR, side({ id: 'survivor' }))).toBe('same_contact');
  });

  it('refuses a loser that has already been merged away', () => {
    // Its rows are somewhere else now, so a second merge would move nothing and
    // leave two tombstones pointing in different directions.
    const merged = side({ id: 'loser', mergedIntoContactId: 'somebody', deletedAt: new Date() });
    expect(refuseMerge(SURVIVOR, merged)).toBe('already_merged');
  });

  it('refuses merging into a tombstone', () => {
    const tombstone = side({ id: 'survivor', mergedIntoContactId: 'somebody' });
    expect(refuseMerge(tombstone, LOSER)).toBe('target_merged');
  });

  it('refuses merging into a deleted contact', () => {
    // Not a tombstone — an ordinary soft delete. Folding live tickets into it
    // would hide them behind a record nobody is looking at.
    expect(refuseMerge(side({ id: 'survivor', deletedAt: new Date() }), LOSER)).toBe(
      'target_deleted',
    );
  });

  it('checks the loser before the survivor', () => {
    // Both are unusable; the message should name the one the agent picked,
    // which is the loser.
    const bothMerged = {
      survivor: side({ id: 'survivor', mergedIntoContactId: 'x' }),
      loser: side({ id: 'loser', mergedIntoContactId: 'y' }),
    };
    expect(refuseMerge(bothMerged.survivor, bothMerged.loser)).toBe('already_merged');
  });
});

describe('reconcileContact', () => {
  it('changes nothing when the survivor already knows everything', () => {
    const survivor = side({ id: 'survivor', name: 'Ali', primaryEmail: 'ali@shipblu.com' });
    const loser = side({ id: 'loser', name: 'Ali Hassan', primaryEmail: 'ali@gmail.com' });

    // The whole point: a merge does not decide which name is right.
    expect(reconcileContact(survivor, loser)).toEqual({});
  });

  it('fills the survivor’s blanks', () => {
    const loser = side({
      id: 'loser',
      name: 'Ali Hassan',
      primaryEmail: 'ali@gmail.com',
      primaryPhone: '201001234567',
      timezone: 'Africa/Cairo',
      companyId: 'company-1',
    });

    expect(reconcileContact(SURVIVOR, loser)).toEqual({
      name: 'Ali Hassan',
      primaryEmail: 'ali@gmail.com',
      primaryPhone: '201001234567',
      timezone: 'Africa/Cairo',
      companyId: 'company-1',
    });
  });

  it('treats whitespace as a blank', () => {
    // A name of ' ' comes from a channel that reported an empty display name,
    // and it should not beat a real one.
    const survivor = side({ id: 'survivor', name: '   ' });
    const loser = side({ id: 'loser', name: 'Ali Hassan' });
    expect(reconcileContact(survivor, loser)).toEqual({ name: 'Ali Hassan' });
  });

  it('adopts a locale the loser actually chose', () => {
    const loser = side({ id: 'loser', locale: 'ar' });
    expect(reconcileContact(SURVIVOR, loser)).toEqual({ locale: 'ar' });
  });

  it('never replaces a locale the survivor chose', () => {
    const survivor = side({ id: 'survivor', locale: 'ar' });
    const loser = side({ id: 'loser', locale: 'en' });
    // 'en' on the loser may only mean nobody ever said, so it cannot outrank a
    // deliberate 'ar' on the survivor.
    expect(reconcileContact(survivor, loser)).toEqual({});
  });

  it('unions the role flags', () => {
    const survivor = side({ id: 'survivor', isShipper: true });
    const loser = side({ id: 'loser', isRecipient: true });
    expect(reconcileContact(survivor, loser)).toEqual({ isRecipient: true });
  });

  it('does not restate a flag the survivor already has', () => {
    const survivor = side({ id: 'survivor', isShipper: true, isRecipient: true });
    const loser = side({ id: 'loser', isShipper: true });
    expect(reconcileContact(survivor, loser)).toEqual({});
  });

  it('keeps the survivor’s custom fields and adds the loser’s extras', () => {
    const survivor = side({ id: 'survivor', customFields: { tier: 'gold', notes: 'careful' } });
    const loser = side({ id: 'loser', customFields: { tier: 'silver', warehouse: 'CAI-1' } });

    expect(reconcileContact(survivor, loser)).toEqual({
      customFields: { tier: 'gold', notes: 'careful', warehouse: 'CAI-1' },
    });
  });

  it('leaves custom fields alone when the loser adds nothing', () => {
    const survivor = side({ id: 'survivor', customFields: { tier: 'gold' } });
    const loser = side({ id: 'loser', customFields: { tier: 'silver' } });
    expect(reconcileContact(survivor, loser)).toEqual({});
  });

  it('never carries the blocked flag in either direction', () => {
    // Blocking is a decision about a record, not a fact about a person. Merging
    // a blocked duplicate away must not block the real customer, and merging an
    // innocent duplicate in must not unblock a survivor.
    const blockedLoser = side({ id: 'loser', isBlocked: true });
    expect(reconcileContact(SURVIVOR, blockedLoser)).toEqual({});

    const blockedSurvivor = side({ id: 'survivor', isBlocked: true });
    expect(reconcileContact(blockedSurvivor, LOSER)).toEqual({});
  });

  it('never returns the columns that identify or retire a row', () => {
    // A patch that could carry `id`, `deletedAt` or `mergedIntoContactId` would
    // let reconciliation resurrect or re-point the survivor as a side effect.
    const loser = side({ id: 'loser', deletedAt: new Date(), mergedIntoContactId: 'x' });
    const patch = reconcileContact(SURVIVOR, loser);

    for (const key of ['id', 'deletedAt', 'mergedIntoContactId', 'isBlocked']) {
      expect(patch).not.toHaveProperty(key);
    }
  });
});
