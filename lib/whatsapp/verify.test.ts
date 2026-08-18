import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyChallenge, verifySignature } from './verify';

const SECRET = 'meta-app-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('verifySignature', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  it('accepts a correct signature', () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(body, sign(body, 'wrong'), SECRET)).toBe(false);
  });

  it('rejects when the body differs by a single byte', () => {
    // The whole point of signing the raw bytes: re-serialised JSON fails here.
    expect(verifySignature(`${body} `, sign(body), SECRET)).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, 'garbage', SECRET)).toBe(false);
    // sha1 was the old Meta header; accepting it would downgrade the check.
    expect(verifySignature(body, sign(body).replace('sha256=', 'sha1='), SECRET)).toBe(false);
  });

  it('rejects a truncated signature instead of throwing', () => {
    expect(verifySignature(body, sign(body).slice(0, 20), SECRET)).toBe(false);
  });

  it('rejects when no app secret is configured', () => {
    expect(verifySignature(body, sign(body), '')).toBe(false);
  });
});

describe('verifyChallenge', () => {
  const token = 'shipblu-verify-token';

  function params(overrides: Record<string, string> = {}): URLSearchParams {
    return new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': token,
      'hub.challenge': '1158201444',
      ...overrides,
    });
  }

  it('echoes the challenge when the token matches', () => {
    expect(verifyChallenge(params(), token)).toBe('1158201444');
  });

  it('refuses a wrong token', () => {
    expect(verifyChallenge(params({ 'hub.verify_token': 'nope' }), token)).toBeNull();
  });

  it('refuses a token that only shares a prefix', () => {
    expect(verifyChallenge(params({ 'hub.verify_token': token.slice(0, 5) }), token)).toBeNull();
  });

  it('refuses any mode other than subscribe', () => {
    expect(verifyChallenge(params({ 'hub.mode': 'unsubscribe' }), token)).toBeNull();
  });

  it('refuses when no verify token is configured', () => {
    expect(verifyChallenge(params(), '')).toBeNull();
  });
});
