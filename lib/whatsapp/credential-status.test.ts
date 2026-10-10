import { describe, expect, it } from 'vitest';
import { type CredentialStatus, credentialBadges, credentialOrigin } from './credential-status';

/**
 * The badges are the console's whole account of a credential nobody can see,
 * so each one has to say exactly what is known — no "never expires" for a
 * token nobody inspected, and no clock that outranks Meta saying no.
 */

const NOW = new Date('2026-10-08T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const healthy: CredentialStatus = {
  accountId: 'a',
  keyId: 'abcdef01',
  keyState: 'current',
  keyProblem: null,
  source: 'embedded_signup',
  tokenType: 'SYSTEM_USER',
  scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  businessId: '1',
  issuedAt: new Date('2026-10-01T00:00:00Z'),
  expiresAt: null,
  dataAccessExpiresAt: null,
  inspectedAt: new Date('2026-10-01T00:00:00Z'),
  obtainedByAgentId: null,
  obtainedByName: null,
  lastVerifiedAt: new Date('2026-10-08T09:00:00Z'),
  lastRefusedAt: null,
  lastRefusal: null,
  storedAt: new Date('2026-10-01T00:00:00Z'),
};

const badges = (status: Partial<CredentialStatus>) =>
  credentialBadges({ ...healthy, ...status }, NOW);
const labels = (status: Partial<CredentialStatus>) => badges(status).map((badge) => badge.label);
const kinds = (status: Partial<CredentialStatus>) => badges(status).map((badge) => badge.kind);

describe('credentialBadges', () => {
  it('says "never expires" only for a token Meta was asked about', () => {
    expect(labels({})).toEqual(['never expires']);
    expect(labels({ inspectedAt: null })).toEqual(['expiry unknown']);
  });

  it('counts down the last week, and only the last week', () => {
    expect(labels({ expiresAt: new Date(NOW.getTime() + 30 * DAY) })).toEqual([]);
    expect(labels({ expiresAt: new Date(NOW.getTime() + 7 * DAY) })).toEqual(['expires in 7 days']);
    expect(labels({ expiresAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) })).toEqual([
      'expires in 1 day',
    ]);
    expect(labels({ expiresAt: new Date(NOW.getTime() - 1) })).toEqual(['expired']);
    expect(kinds({ expiresAt: new Date(NOW.getTime() + DAY) })).toEqual(['expires_soon']);
  });

  it('badges a refusal since the last success, and clears it after one', () => {
    const refused = { lastRefusedAt: new Date('2026-10-08T09:30:00Z') };
    expect(kinds(refused)).toContain('refused');
    expect(kinds({ ...refused, lastVerifiedAt: new Date('2026-10-08T09:45:00Z') })).not.toContain(
      'refused',
    );
  });

  it('puts the key first, because nothing else works until it is fixed', () => {
    expect(badges({ keyState: 'no_key' })[0]).toMatchObject({
      kind: 'key_not_set',
      label: 'key not set',
    });
    expect(badges({ keyState: 'no_key', keyProblem: 'malformed' })[0]).toMatchObject({
      kind: 'key_misconfigured',
    });
    expect(badges({ keyState: 'unknown' })[0]).toMatchObject({
      kind: 'key_unknown',
      tone: 'danger',
    });
    expect(badges({ keyState: 'previous' })[0]).toMatchObject({
      kind: 'key_previous',
      tone: 'warning',
    });
  });

  /**
   * A badge does not wrap, and the account card is a phone's width: the key id
   * and the variable name ran off its edge. They belong to the explanation.
   */
  it('keeps every label short, and the key id and variable names out of it', () => {
    const every = [
      ...badges({ keyState: 'no_key' }),
      ...badges({ keyState: 'no_key', keyProblem: 'malformed' }),
      ...badges({ keyState: 'unknown', lastRefusedAt: new Date('2026-10-08T09:30:00Z') }),
      ...badges({ keyState: 'previous', inspectedAt: null }),
      ...badges({ expiresAt: new Date(NOW.getTime() + 3 * DAY) }),
      ...badges({ expiresAt: new Date(NOW.getTime() - 1) }),
    ];
    expect(new Set(every.map((badge) => badge.kind)).size).toBe(9);
    for (const badge of every) {
      expect(badge.label.length).toBeLessThanOrEqual(20);
      expect(badge.label).not.toMatch(/abcdef01|WHATSAPP_/);
    }
  });
});

describe('credentialOrigin', () => {
  // `storedAt` is 00:00 UTC, which is 03:00 in Cairo under its summer time:
  // the card is read in the team's zone, as every other date in the console.
  it('names the agent who connected it', () => {
    expect(credentialOrigin({ ...healthy, obtainedByName: 'Mona Admin' })).toBe(
      'Stored from Embedded Signup on 1 Oct 2026, 03:00 by Mona Admin',
    );
  });

  /**
   * Deleting the agent sets the id, and so the name, null. "by null" is a bug
   * on the page and "by unknown" accuses a credential the audit row still
   * accounts for, so the clause goes rather than being filled in.
   */
  it('leaves the "by" clause out when no agent row answers', () => {
    expect(credentialOrigin(healthy)).toBe('Stored from Embedded Signup on 1 Oct 2026, 03:00');
    expect(credentialOrigin({ ...healthy, obtainedByName: '' })).toBe(
      'Stored from Embedded Signup on 1 Oct 2026, 03:00',
    );
  });
});
