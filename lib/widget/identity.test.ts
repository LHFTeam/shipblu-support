import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import {
  claimNamesSomebody,
  identityKey,
  judgeSignature,
  parseIdentity,
  signedClaim,
  type WidgetIdentity,
} from './identity';

/**
 * The identity a host page sends is the one input to this system that is
 * attacker-controlled *and* shaped like something we trust, so the tests worth
 * having are about what the parser refuses and what the signature covers.
 */

const SECRET = 'a-shared-secret-for-the-dashboard';

withTestEnv();

/** What the merchant dashboard actually sends, in the Freshchat shape. */
function dashboardUser(overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Nour',
    lastName: 'Adel',
    email: 'Nour@Merchant.example ',
    phone: '+20 100 123 4567',
    accountId: 4471,
    accountName: 'Acme Trading',
    meta: { plan: 'gold' },
    ...overrides,
  };
}

describe('parseIdentity', () => {
  it('reads the shape a dashboard holds a user in', () => {
    expect(parseIdentity(dashboardUser())).toEqual({
      name: 'Nour Adel',
      // Lower-cased and trimmed, because `contact_identities` is unique on the
      // normalised form and an identity that does not match cannot be found.
      email: 'nour@merchant.example',
      phone: '201001234567',
      // A number, because a dashboard holds an account id as one.
      accountId: '4471',
      accountName: 'Acme Trading',
      fields: { plan: 'gold' },
    } satisfies WidgetIdentity);
  });

  it('prefers an explicit name over the two halves', () => {
    expect(parseIdentity({ name: 'Nour A.', firstName: 'Nour', lastName: 'Adel' })?.name).toBe(
      'Nour A.',
    );
  });

  it('keeps a half-filled name rather than dropping it', () => {
    expect(parseIdentity({ firstName: 'Nour' })?.name).toBe('Nour');
  });

  it('drops an address that is not one, rather than storing it', () => {
    // It ends up on the contact an agent reads and is linked in
    // `contact_identities`; a value that cannot be replied to is worse there
    // than no value at all.
    expect(parseIdentity({ email: 'not-an-address' })).toBeNull();
    expect(parseIdentity({ email: 'nour@merchant' })).toBeNull();
  });

  it('drops a phone number too short to be one', () => {
    expect(parseIdentity({ phone: '123' })).toBeNull();
    expect(parseIdentity({ phone: '+20 100 123 4567' })?.phone).toBe('201001234567');
  });

  it('refuses free-form keys in the extra fields', () => {
    const identity = parseIdentity({
      accountId: '4471',
      meta: {
        cf_sb_account_tier: 'gold',
        'not a key': 'dropped',
        '2fa': 'dropped',
        nested: { still: 'dropped' },
      },
    });

    expect(identity?.fields).toEqual({ cf_sb_account_tier: 'gold' });
  });

  it('is null when there is nothing worth recording', () => {
    expect(parseIdentity({ locale: 'ar' })).toBeNull();
    expect(parseIdentity(null)).toBeNull();
    expect(parseIdentity('nour@merchant.example')).toBeNull();
  });

  it('caps a value rather than storing a document in a jsonb column', () => {
    expect(parseIdentity({ accountName: 'x'.repeat(500) })?.accountName).toHaveLength(200);
  });
});

describe('identityKey', () => {
  it('is the account before the address', () => {
    // Two people at one merchant are one customer for support purposes, so the
    // account is what decides whether the browser changed hands.
    const identity = parseIdentity(dashboardUser())!;
    expect(identityKey(identity)).toBe('account:4471');
    expect(identityKey(parseIdentity({ email: 'nour@merchant.example' })!)).toBe(
      'email:nour@merchant.example',
    );
  });

  it('is null for an identity that says only what to call somebody', () => {
    // A name alone cannot tell one visitor from another, so it must never be
    // the thing a session reset is decided on.
    expect(identityKey(parseIdentity({ name: 'Nour Adel' })!)).toBeNull();
  });
});

/**
 * `judgeSignature` is the module's one public decision; what a signature covers
 * and what it proves is tested through it.
 */
describe('judgeSignature', () => {
  function sign(identity: WidgetIdentity, secret = SECRET): string {
    return createHmac('sha256', secret).update(signedClaim(identity)).digest('hex');
  }

  /** Parsed the way the route parses it, with the raw shape kept beside it. */
  function judge(raw: Record<string, unknown>, signature: string) {
    return judgeSignature(parseIdentity(raw)!, signature, raw);
  }

  it('accepts what the host backend signed', () => {
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const identity = parseIdentity(dashboardUser())!;
    expect(judge(dashboardUser(), sign(identity))).toBe('verified');
    expect(judge(dashboardUser(), sign(identity).toUpperCase())).toBe('verified');
  });

  it('ignores changes to the parts it does not cover', () => {
    // Name, phone and the extra fields are decoration. Covering them would mean
    // a merchant renaming themselves in the dashboard silently stops being
    // identified at all, which is the failure nobody would diagnose.
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const signature = sign(parseIdentity(dashboardUser())!);
    expect(judge(dashboardUser({ firstName: 'Someone', phone: '201110000000' }), signature)).toBe(
      'verified',
    );
  });

  it('refuses a claim to a different account or address while signing is on', () => {
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const signature = sign(parseIdentity(dashboardUser())!);
    expect(judge(dashboardUser({ accountId: 4472 }), signature)).toBe('refused');
    expect(judge(dashboardUser({ email: 'someone@else.example' }), signature)).toBe('refused');
    expect(judge({ email: 'nour@merchant.example' }, 'f'.repeat(64))).toBe('refused');
  });

  it('refuses a signature made with another environment secret', () => {
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const identity = parseIdentity(dashboardUser())!;
    expect(judge(dashboardUser(), sign(identity, 'the-staging-secret'))).toBe('refused');
  });

  it('verifies nothing, and refuses nothing, when no secret is configured', () => {
    // The identity is still accepted — it just never becomes a fact, so the
    // account link is not written.
    const identity = parseIdentity(dashboardUser())!;
    expect(judge(dashboardUser(), sign(identity))).toBe('unverified');
    expect(judge(dashboardUser(), 'f'.repeat(64))).toBe('unverified');
  });

  it('is unverified with no signature, a blank one included', () => {
    // Trimmed here rather than trusted to the caller, so a blank signature is
    // no signature whoever passes it.
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    expect(judge(dashboardUser(), '')).toBe('unverified');
    expect(judge(dashboardUser(), '   ')).toBe('unverified');
  });

  it('leaves a phone-only identity unverified with a valid signature of "|", not refused', () => {
    // A phone alone signs the constant "|". One HMAC of it, minted by any
    // integrator's backend for its first phone-only user, would otherwise be a
    // valid signature for every phone number, and `identityKey` keys the
    // contact on the phone the signature never mentioned. Unverified rather
    // than a 401: a deployed integration signing every user it has must not
    // start failing for the ones without an email.
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const raw = { phone: '+20 100 123 4567', name: 'Nour Adel' };
    const identity = parseIdentity(raw)!;
    expect(signedClaim(identity)).toBe('|');
    expect(identityKey(identity)).toBe('phone:201001234567');
    expect(claimNamesSomebody(identity)).toBe(false);
    expect(sign(identity)).toBe(createHmac('sha256', SECRET).update('|').digest('hex'));
    expect(judge(raw, sign(identity))).toBe('unverified');
  });

  it('leaves a phone-only identity unverified with a wrong signature too', () => {
    // It could not have proved anything right, so it is not refused for being wrong.
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    expect(judge({ phone: '+20 100 123 4567' }, 'f'.repeat(64))).toBe('unverified');
    expect(judge({ accountName: 'Acme Trading' }, sign(parseIdentity({ accountName: 'x' })!))).toBe(
      'unverified',
    );
  });

  it('still verifies an account alone or an address alone', () => {
    // Each names somebody; the other half is simply its empty side of the `|`.
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const accountOnly = { accountId: 4471, phone: '+20 100 123 4567' };
    const emailOnly = { email: 'nour@merchant.example' };

    expect(signedClaim(parseIdentity(accountOnly)!)).toBe('4471|');
    expect(judge(accountOnly, sign(parseIdentity(accountOnly)!))).toBe('verified');
    expect(signedClaim(parseIdentity(emailOnly)!)).toBe('|nour@merchant.example');
    expect(judge(emailOnly, sign(parseIdentity(emailOnly)!))).toBe('verified');
  });

  it('refuses when the host named an account id or email the parser dropped', () => {
    // The host signed the raw value, so its signature is wrong rather than
    // empty: a broken integration, which the 401 makes visible. Still never
    // verified, even signed over "|" — that is the replay this module closes.
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const badEmail = { email: 'nour@merchant', phone: '+20 100 123 4567' };
    expect(parseIdentity(badEmail)!.email).toBeNull();
    expect(
      judge(badEmail, createHmac('sha256', SECRET).update('|nour@merchant').digest('hex')),
    ).toBe('refused');
    expect(judge(badEmail, sign(parseIdentity(badEmail)!))).toBe('refused');

    const punctuationAccount = { accountId: '#/#', phone: '+20 100 123 4567' };
    expect(parseIdentity(punctuationAccount)!.accountId).toBeNull();
    expect(judge(punctuationAccount, 'f'.repeat(64))).toBe('refused');
    expect(judge({ account_id: '#', phone: '+20 100 123 4567' }, 'f'.repeat(64))).toBe('refused');
  });
});
