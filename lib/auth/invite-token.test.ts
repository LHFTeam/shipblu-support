import { describe, expect, it } from 'vitest';
import { sealInviteToken, unsealInviteToken } from './invite-token';

const SECRET = 'test-secret-long-enough-to-match-production';

describe('stored invite tokens', () => {
  it('round-trips the original token without storing it in plaintext', () => {
    const token = 'the-original-invite-token';
    const sealed = sealInviteToken(token, SECRET);

    expect(sealed).not.toContain(token);
    expect(unsealInviteToken(sealed, SECRET)).toBe(token);
  });

  it('uses a fresh IV for each stored copy', () => {
    const first = sealInviteToken('same-token', SECRET);
    const second = sealInviteToken('same-token', SECRET);

    expect(first).not.toBe(second);
    expect(unsealInviteToken(first, SECRET)).toBe('same-token');
    expect(unsealInviteToken(second, SECRET)).toBe('same-token');
  });

  it('refuses malformed, altered and differently keyed values', () => {
    const sealed = sealInviteToken('invite-token', SECRET);
    const [version, iv, body, tag] = sealed.split('.');
    const alteredBody = Buffer.from(body!, 'base64url');
    alteredBody[0] = alteredBody[0]! ^ 1;
    const altered = [version, iv, alteredBody.toString('base64url'), tag].join('.');

    expect(unsealInviteToken('not-an-envelope', SECRET)).toBeNull();
    expect(unsealInviteToken(altered, SECRET)).toBeNull();
    expect(unsealInviteToken(sealed, 'a-different-secret')).toBeNull();
  });
});
