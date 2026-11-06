import { describe, expect, it } from 'vitest';
import { judge, statementOf, UNMATCHED, type PersonPrint, type Standing } from './person';

const said = async (person: unknown) => (await statementOf(person, true)) as PersonPrint;

const NOUR = { accountId: '4471', email: 'nour@merchant.example', phone: '+20 100 123 4567' };
const OMAR = { accountId: '4471', email: 'omar@merchant.example' };

describe('statementOf', () => {
  it('reads an identity the way the server parses it', async () => {
    const typed = await said({ accountId: 4471, email: ' Nour@Merchant.example ' });
    expect(typed).toEqual(await said({ accountId: '4471', email: 'nour@merchant.example' }));
    expect(await said({ account_id: '4471', email: 'nour@merchant.example' })).toEqual(typed);
  });

  it('keeps each field as its own digest, with no plain value left in it', async () => {
    const print = await said(NOUR);
    for (const value of [print.account, print.email, print.phone]) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(print)).not.toContain('nour');
    // One value under two names is two different fields.
    const same = await said({ accountId: '447100', phone: '447100' });
    expect(same.account).not.toBe(same.phone);
  });

  it('keeps "does not say", "nobody" and a person apart', async () => {
    expect(await statementOf(undefined, false)).toBeUndefined();
    expect(await statementOf(null, true)).toBeNull();
    expect(await statementOf({ accountId: null, email: null, phone: null }, true)).toBeNull();
    expect(await statementOf({ name: 'Nour', meta: { tier: 'gold' } }, true)).toBeNull();
    expect(await statementOf({ email: 'not an address' }, true)).toBeNull();
  });
});

describe('judge, a stored token at open', () => {
  const stored = (stated: Parameters<typeof judge>[0], recorded: PersonPrint | null) =>
    judge(stated, recorded, 'stored').verdict;

  it('reopens it for the person it was vouched for, and for a snippet that does not say', async () => {
    expect(stored(await said(NOUR), await said(NOUR))).toBe('open');
    expect(stored(undefined, await said(NOUR))).toBe('open');
  });

  it('throws it away for somebody else, and reopens it for no page naming only the account', async () => {
    expect(stored(await said(OMAR), await said(NOUR))).toBe('discard');
    expect(stored(await said({ accountId: '4471' }), await said(NOUR))).toBe('leave');
    expect(stored(await said({ accountId: '9999', email: NOUR.email }), await said(NOUR))).toBe(
      'discard',
    );
  });

  it('refuses one never vouched for to a page that names somebody: every token from before the check', async () => {
    expect(stored(await said(NOUR), null)).toBe('discard');
  });

  it("leaves a merchant's conversation in storage for a page that names nobody, or cannot say who", async () => {
    expect(stored(null, await said(NOUR))).toBe('leave');
    expect(stored(UNMATCHED, await said(NOUR))).toBe('leave');
    expect(stored(UNMATCHED, null)).toBe('leave');
    // An anonymous conversation on an anonymous page is as it always was.
    expect(stored(null, null)).toBe('open');
  });

  it('waits for the rest of a page that says less than the record, and takes up what it adds', async () => {
    const full = await said(NOUR);
    // The email first, the account once the profile has loaded.
    expect(stored(await said({ email: NOUR.email }), full)).toBe('leave');
    const added = judge(full, await said({ email: NOUR.email }), 'stored');
    expect(added).toEqual({ verdict: 'open', record: full });
  });

  it('never lets agreeing on the account alone claim a person', async () => {
    // Vouched for by the account only, then met by the account and an email:
    // any of the account's people could be the one reading.
    expect(stored(await said(OMAR), await said({ accountId: '4471' }))).toBe('discard');
    expect(stored(await said({ accountId: '4471' }), await said({ accountId: '4471' }))).toBe(
      'open',
    );
  });

  it('reads the phone only where neither side has an email', async () => {
    const edited = await said({ ...NOUR, phone: '+20 100 765 4321' });
    expect(stored(edited, await said(NOUR))).toBe('open');
    const byPhone = await said({ accountId: '4471', phone: '+20 100 123 4567' });
    expect(stored(await said({ accountId: '4471', phone: '+20 111 222 3333' }), byPhone)).toBe(
      'discard',
    );
    expect(stored(byPhone, byPhone)).toBe('open');
  });
});

describe('judge, the session already open', () => {
  const active = async (standing: Standing, stated: unknown, recorded: unknown) =>
    judge(
      stated === UNMATCHED || stated === null ? stated : await said(stated),
      recorded ? await said(recorded) : null,
      standing,
    );

  it('keeps it, and records the person, for whoever a token minted here was minted for', async () => {
    expect(await active('minted', NOUR, null)).toEqual({
      verdict: 'open',
      record: await said(NOUR),
    });
    // Nothing to record, and nothing to refuse: no loop of fresh sessions.
    expect((await active('minted', UNMATCHED, null)).verdict).toBe('open');
  });

  it('throws it away when the page names somebody else', async () => {
    expect((await active('minted', OMAR, NOUR)).verdict).toBe('discard');
    expect((await active('resumed', OMAR, NOUR)).verdict).toBe('discard');
  });

  it('refuses a reopened token never vouched for, and one nothing here can check', async () => {
    expect((await active('resumed', NOUR, null)).verdict).toBe('discard');
    expect((await active('resumed', UNMATCHED, NOUR)).verdict).toBe('discard');
    expect((await active('minted', UNMATCHED, NOUR)).verdict).toBe('discard');
  });

  it('adds a field the page hands over later, and keeps going on one it leaves out', async () => {
    const upgraded = await active('resumed', NOUR, { email: NOUR.email });
    expect(upgraded).toEqual({ verdict: 'open', record: await said(NOUR) });
    expect(await active('resumed', { email: NOUR.email }, NOUR)).toEqual({
      verdict: 'open',
      record: null,
    });
  });

  it('keeps it when the page names nobody, which is not a sign-out', async () => {
    expect((await active('resumed', null, NOUR)).verdict).toBe('open');
  });
});
