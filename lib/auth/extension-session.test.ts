import { describe, expect, it } from 'vitest';
import { bearerToken } from './extension-session';

describe('bearerToken', () => {
  it('reads the token after the scheme, in any case', () => {
    expect(bearerToken('Bearer abc_DEF-123')).toBe('abc_DEF-123');
    expect(bearerToken('bearer abc')).toBe('abc');
  });

  it('answers null for no header, another scheme, or more than one token', () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer one two')).toBeNull();
    // A cookie-shaped value pasted where a token goes is not a token.
    expect(bearerToken('Bearer sb_session=abc')).toBeNull();
  });
});
