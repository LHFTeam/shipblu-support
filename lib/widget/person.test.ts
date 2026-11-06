import { describe, expect, it } from 'vitest';
import { mayResume, personDigest, personKey, statementOf, UNMATCHED } from './person';

describe('personKey', () => {
  it('reads an identity the way the server parses it', () => {
    const typed = personKey({ accountId: 4471, email: ' Nour@Merchant.example ' });
    expect(typed).toBe(personKey({ accountId: '4471', email: 'nour@merchant.example' }));
    expect(personKey({ account_id: '4471', email: 'nour@merchant.example' })).toBe(typed);
  });

  it('is the account, the email, and the phone only when there is no email', () => {
    const withEmail = personKey({
      accountId: '4471',
      email: 'a@merchant.example',
      phone: '+20 100',
    });
    expect(withEmail).toBe(personKey({ accountId: '4471', email: 'a@merchant.example' }));

    const byPhone = personKey({ accountId: '4471', phone: '+20 100 123 4567' });
    expect(byPhone).not.toBe(personKey({ accountId: '4471', phone: '+20 100 765 4321' }));
  });

  it('tells two colleagues of one account apart, which the server key does not', () => {
    expect(personKey({ accountId: '4471', email: 'nour@merchant.example' })).not.toBe(
      personKey({ accountId: '4471', email: 'omar@merchant.example' }),
    );
    // One of them with no email is a different key too, not a match on the account.
    expect(personKey({ accountId: '4471', email: 'nour@merchant.example' })).not.toBe(
      personKey({ accountId: '4471' }),
    );
  });

  it('names nobody when nothing identifies a person', () => {
    expect(personKey(null)).toBeNull();
    expect(personKey({})).toBeNull();
    expect(personKey({ name: 'Nour', meta: { tier: 'gold' } })).toBeNull();
    expect(personKey({ email: 'not an address' })).toBeNull();
  });
});

describe('personDigest', () => {
  it('is a stable SHA-256 hex digest that carries no plain email', async () => {
    const key = personKey({ accountId: '4471', email: 'nour@merchant.example' });
    const digest = await personDigest(key);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await personDigest(key)).toBe(digest);
    expect(digest).not.toContain('nour');
    expect(await personDigest(null)).toBeNull();
  });
});

describe('statementOf', () => {
  it('keeps "does not say", "nobody" and a person apart', async () => {
    expect(await statementOf(undefined, false)).toBeUndefined();
    expect(await statementOf(null, true)).toBeNull();
    expect(await statementOf({ accountId: null, email: null, phone: null }, true)).toBeNull();
    expect(await statementOf({ accountId: '4471', email: 'nour@merchant.example' }, true)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

describe('mayResume', () => {
  const nour = 'a'.repeat(64);
  const omar = 'b'.repeat(64);

  it.each([
    ['a snippet that does not say, whatever the record', undefined, nour, true],
    ['a snippet that does not say, no record', undefined, null, true],
    ['nobody named, never vouched for', null, null, true],
    ['nobody named, vouched for somebody', null, nour, false],
    ['the person it was vouched for', nour, nour, true],
    ['somebody else', omar, nour, false],
    ['somebody, never vouched for: every token left before the check', nour, null, false],
    ['a person whose digest could not be taken', UNMATCHED, null, false],
  ])('%s', (_case, stated, recorded, expected) => {
    expect(mayResume(stated, recorded)).toBe(expected);
  });
});
