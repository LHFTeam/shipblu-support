import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import {
  identitySigningEnabled,
  identityKey,
  parseIdentity,
  signedClaim,
  verifyIdentity,
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

describe('verifyIdentity', () => {
  function sign(identity: WidgetIdentity, secret = SECRET): string {
    return createHmac('sha256', secret).update(signedClaim(identity)).digest('hex');
  }

  it('accepts what the host backend signed', () => {
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const identity = parseIdentity(dashboardUser())!;
    expect(verifyIdentity(identity, sign(identity))).toBe(true);
    expect(verifyIdentity(identity, sign(identity).toUpperCase())).toBe(true);
  });

  it('ignores changes to the parts it does not cover', () => {
    // Name, phone and the extra fields are decoration. Covering them would mean
    // a merchant renaming themselves in the dashboard silently stops being
    // identified at all, which is the failure nobody would diagnose.
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const signature = sign(parseIdentity(dashboardUser())!);
    const renamed = parseIdentity(dashboardUser({ firstName: 'Someone', phone: '201110000000' }))!;

    expect(verifyIdentity(renamed, signature)).toBe(true);
  });

  it('rejects a claim to a different account or address', () => {
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const signature = sign(parseIdentity(dashboardUser())!);

    expect(verifyIdentity(parseIdentity(dashboardUser({ accountId: 4472 }))!, signature)).toBe(
      false,
    );
    expect(
      verifyIdentity(parseIdentity(dashboardUser({ email: 'someone@else.example' }))!, signature),
    ).toBe(false);
  });

  it('rejects a signature made with another environment secret', () => {
    setTestEnv({ WIDGET_IDENTITY_SECRET: SECRET });

    const identity = parseIdentity(dashboardUser())!;
    expect(verifyIdentity(identity, sign(identity, 'the-staging-secret'))).toBe(false);
  });

  it('verifies nothing when no secret is configured', () => {
    // The identity is still accepted — it just never becomes a fact, so the
    // account link is not written.
    const identity = parseIdentity(dashboardUser())!;

    expect(identitySigningEnabled()).toBe(false);
    expect(verifyIdentity(identity, sign(identity))).toBe(false);
  });
});
