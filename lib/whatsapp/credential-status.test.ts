import { describe, expect, it } from 'vitest';
import { type CredentialStatus, credentialBadges } from './credential-status';

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
  lastVerifiedAt: new Date('2026-10-08T09:00:00Z'),
  lastRefusedAt: null,
  lastRefusal: null,
  storedAt: new Date('2026-10-01T00:00:00Z'),
};

const labels = (status: Partial<CredentialStatus>) =>
  credentialBadges({ ...healthy, ...status }, NOW).map((badge) => badge.label);

describe('credentialBadges', () => {
  it('says "never expires" only for a token Meta was asked about', () => {
    expect(labels({})).toEqual(['never expires']);
    expect(labels({ inspectedAt: null })).toEqual(['expiry unknown']);
  });

  it('counts down the last week, and only the last week', () => {
    expect(labels({ expiresAt: new Date(NOW.getTime() + 30 * DAY) })).toEqual([]);
    expect(labels({ expiresAt: new Date(NOW.getTime() + 7 * DAY) })).toEqual([
      'credential expires in 7 days',
    ]);
    expect(labels({ expiresAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) })).toEqual([
      'credential expires in 1 day',
    ]);
    expect(labels({ expiresAt: new Date(NOW.getTime() - 1) })).toEqual(['credential expired']);
  });

  it('badges a refusal since the last success, and clears it after one', () => {
    const refused = { lastRefusedAt: new Date('2026-10-08T09:30:00Z') };
    expect(labels(refused)).toContain('credential refused by Meta');
    expect(labels({ ...refused, lastVerifiedAt: new Date('2026-10-08T09:45:00Z') })).not.toContain(
      'credential refused by Meta',
    );
  });

  it('puts the key first, because nothing else works until it is fixed', () => {
    expect(labels({ keyState: 'no_key' })[0]).toBe(
      'credential key not set — WHATSAPP_CREDENTIAL_KEY',
    );
    expect(labels({ keyState: 'no_key', keyProblem: 'malformed' })[0]).toBe(
      'credential key misconfigured',
    );
    expect(labels({ keyState: 'unknown' })[0]).toMatch(
      /abcdef01, which this deployment does not hold/,
    );
    expect(labels({ keyState: 'previous' })[0]).toMatch(/rotation pending/);
  });
});
