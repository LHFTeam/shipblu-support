import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import {
  parseTokenEnvVar,
  resolveAccount,
  resolveCredentialSource,
  tokenForAccount,
} from './accounts';
import { CredentialKeyError } from './credential-envelope';

/** The stored credential, per account id — what `storedTokenFor` would open. */
const stored = vi.hoisted(() => new Map<string, string | Error>());

vi.mock('./credentials', () => ({
  storedCredentialExists: () => null,
  storedTokenFor: async (account: { id: string }) => {
    const value = stored.get(account.id);
    if (value instanceof Error) throw value;
    return value ?? null;
  },
}));

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
  egypt: { id: 'a', wabaId: '111', isDefault: true, isActive: true, tokenEnvVar: null },
  saudi: {
    id: 'b',
    wabaId: '222',
    isDefault: false,
    isActive: true,
    tokenEnvVar: 'WHATSAPP_TOKEN_SAUDI',
  },
  retired: { id: 'c', wabaId: '333', isDefault: false, isActive: false, tokenEnvVar: null },
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

describe('resolveCredentialSource', () => {
  it('prefers a stored credential, then a named variable, then the shared token', () => {
    expect(resolveCredentialSource(ACCOUNTS.saudi, true)).toBe('stored');
    expect(resolveCredentialSource(ACCOUNTS.egypt, true)).toBe('stored');
    expect(resolveCredentialSource(ACCOUNTS.saudi, false)).toBe('variable');
    expect(resolveCredentialSource(ACCOUNTS.egypt, false)).toBe('shared');
    expect(resolveCredentialSource(null, false)).toBe('shared');
  });
});

describe('tokenForAccount', () => {
  withTestEnv({ META_PAGE_ACCESS_TOKEN: 'shared-token', WHATSAPP_TOKEN_SAUDI: 'saudi-token' });
  beforeEach(() => stored.clear());

  it('uses the shared token when the account names none', async () => {
    expect(await tokenForAccount(ACCOUNTS.egypt)).toEqual({
      token: 'shared-token',
      source: 'shared',
    });
    expect(await tokenForAccount(null)).toEqual({ token: 'shared-token', source: 'shared' });
  });

  it('reads the variable the account names', async () => {
    expect(await tokenForAccount(ACCOUNTS.saudi)).toEqual({
      token: 'saudi-token',
      source: 'variable',
    });
  });

  it('sends with a stored credential ahead of a variable on the same row', async () => {
    stored.set('b', 'stored-saudi-token');
    expect(await tokenForAccount(ACCOUNTS.saudi)).toEqual({
      token: 'stored-saudi-token',
      source: 'stored',
    });
  });

  /**
   * The failure this order exists to prevent. A stored credential that cannot
   * be opened — the key is unset, rotated away, or the envelope was moved —
   * must stop the send, not quietly authenticate it as the shared token.
   */
  it('throws when a stored credential cannot be opened, rather than falling through', async () => {
    stored.set(
      'a',
      new CredentialKeyError('unset', 'WHATSAPP_CREDENTIAL_KEY is not set, so no stored …'),
    );
    await expect(tokenForAccount(ACCOUNTS.egypt)).rejects.toThrow(CredentialKeyError);
  });

  /**
   * Names the variable rather than reporting a Graph 401 an hour later. The
   * row can be saved before the value is added to the environment group, and
   * that gap is the ordinary way this is set up.
   */
  it('names the missing variable when it is not set', async () => {
    setTestEnv({ WHATSAPP_TOKEN_SAUDI: undefined });
    await expect(tokenForAccount(ACCOUNTS.saudi)).rejects.toThrow(/WHATSAPP_TOKEN_SAUDI/);
  });

  /** The row could predate the rule, or have been edited straight in the database. */
  it('refuses a variable a save would never have accepted', async () => {
    await expect(
      tokenForAccount({ id: 'x', wabaId: '444', tokenEnvVar: 'DATABASE_URL' }),
    ).rejects.toThrow(/not a usable token/);
  });
});
