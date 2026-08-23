import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { parseTokenEnvVar, resolveAccount, tokenForAccount } from './accounts';

/**
 * The two decisions in this module that have no database in them, and both of
 * which fail silently when they are wrong.
 *
 * `parseTokenEnvVar` is the boundary between "an admin names a variable" and
 * "the process sends that variable's value to Meta as a bearer token". A hole
 * in it leaks a credential nobody ever sees on screen.
 *
 * `resolveAccount` decides which business account a reply goes out on. Getting
 * it wrong does not fail the send: Meta accepts the call, returns a message id,
 * and rejects the message later on a status webhook.
 */

const ACCOUNTS = {
  egypt: { id: 'a', isDefault: true, isActive: true, tokenEnvVar: null },
  saudi: { id: 'b', isDefault: false, isActive: true, tokenEnvVar: 'WHATSAPP_TOKEN_SAUDI' },
  retired: { id: 'c', isDefault: false, isActive: false, tokenEnvVar: null },
};

describe('parseTokenEnvVar', () => {
  it('treats blank as the shared token', () => {
    expect(parseTokenEnvVar('')).toEqual({ ok: true, value: null });
    expect(parseTokenEnvVar('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts the shared variable spelled out, as the same thing', () => {
    expect(parseTokenEnvVar('META_PAGE_ACCESS_TOKEN')).toEqual({ ok: true, value: null });
  });

  it('accepts a prefixed name, normalised to upper case', () => {
    expect(parseTokenEnvVar(' whatsapp_token_egypt ')).toEqual({
      ok: true,
      value: 'WHATSAPP_TOKEN_EGYPT',
    });
  });

  /**
   * The point of the prefix. An admin naming any variable they like would be
   * choosing which of the process's secrets is posted to graph.facebook.com in
   * an Authorization header — and they never see the value, so nothing about
   * the screen would look wrong afterwards.
   */
  it('refuses a variable that is not a WhatsApp token', () => {
    for (const name of [
      'DATABASE_URL',
      'APP_SECRET',
      'META_APP_SECRET',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]) {
      expect(parseTokenEnvVar(name).ok).toBe(false);
    }
  });

  it('refuses a name that only starts like one', () => {
    expect(parseTokenEnvVar('WHATSAPP_TOKENS').ok).toBe(false);
    expect(parseTokenEnvVar('WHATSAPP_TOKEN_').ok).toBe(false);
    expect(parseTokenEnvVar('MY_WHATSAPP_TOKEN_X').ok).toBe(false);
  });

  it('refuses anything that is not a variable name at all', () => {
    expect(parseTokenEnvVar('WHATSAPP_TOKEN_A B').ok).toBe(false);
    expect(parseTokenEnvVar('WHATSAPP_TOKEN_A;RM').ok).toBe(false);
  });
});

describe('resolveAccount', () => {
  const all = [ACCOUNTS.egypt, ACCOUNTS.saudi, ACCOUNTS.retired];

  it('uses the account the number is linked to', () => {
    expect(resolveAccount(all, 'b')).toBe(ACCOUNTS.saudi);
  });

  /**
   * Switching an account off must not reroute its numbers. A reply sent from a
   * different business account is a re-engagement message to a customer who
   * never engaged with it, which Meta rejects asynchronously — the agent is
   * told it went, and it did not.
   */
  it('keeps using a linked account that has been switched off', () => {
    expect(resolveAccount(all, 'c')).toBe(ACCOUNTS.retired);
  });

  it('falls back to the default when the number names nothing', () => {
    expect(resolveAccount(all, null)).toBe(ACCOUNTS.egypt);
  });

  it('falls back to the default when the link points at a deleted account', () => {
    expect(resolveAccount(all, 'gone')).toBe(ACCOUNTS.egypt);
  });

  it('skips a default that is switched off rather than sending on it', () => {
    const offDefault = { id: 'a', isDefault: true, isActive: false };
    const other = { id: 'b', isDefault: false, isActive: true };
    expect(resolveAccount([offDefault, other], null)).toBe(other);
  });

  it('is null when nothing is connected, which is the environment fallback', () => {
    expect(resolveAccount([], null)).toBeNull();
  });
});

describe('tokenForAccount', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://localhost/test';
    process.env.APP_SECRET = 'x'.repeat(32);
    process.env.META_PAGE_ACCESS_TOKEN = 'shared-token';
    process.env.WHATSAPP_TOKEN_SAUDI = 'saudi-token';
    resetEnvCache();
  });

  afterEach(() => {
    delete process.env.META_PAGE_ACCESS_TOKEN;
    delete process.env.WHATSAPP_TOKEN_SAUDI;
    resetEnvCache();
  });

  it('uses the shared token when the account names none', () => {
    expect(tokenForAccount(ACCOUNTS.egypt)).toBe('shared-token');
    expect(tokenForAccount(null)).toBe('shared-token');
  });

  it('reads the variable the account names', () => {
    expect(tokenForAccount(ACCOUNTS.saudi)).toBe('saudi-token');
  });

  /**
   * Names the variable rather than reporting a Graph 401 an hour later. The
   * row can be saved before the value is added to the environment group, and
   * that gap is the ordinary way this is set up.
   */
  it('names the missing variable when it is not set', () => {
    delete process.env.WHATSAPP_TOKEN_SAUDI;
    expect(() => tokenForAccount(ACCOUNTS.saudi)).toThrow(/WHATSAPP_TOKEN_SAUDI/);
  });

  /** The row could predate the rule, or have been edited straight in the database. */
  it('refuses a variable a save would never have accepted', () => {
    expect(() => tokenForAccount({ tokenEnvVar: 'DATABASE_URL' })).toThrow(/not a usable token/);
  });
});
