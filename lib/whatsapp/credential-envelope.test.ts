import { describe, expect, it } from 'vitest';
import {
  CredentialKeyError,
  envelopeKeyId,
  keyStateOf,
  parseKeyring,
  seal,
  unseal,
} from './credential-envelope';

/**
 * The envelope is the whole of what keeps a stored WhatsApp token out of a
 * database dump, so these are the properties a dump-holder would try first:
 * that nothing readable is in it, that it cannot be moved to another row, that
 * it cannot be altered, and that the error sentences never repeat a key.
 */

const KEY_A = 'a'.repeat(20) + 'key-a-0123456789abcdef';
const KEY_B = 'b'.repeat(20) + 'key-b-0123456789abcdef';
const TOKEN = 'EAAGm0PX4ZCpsBAEXAMPLEtokenValue1234567890';
const ROW = { accountId: '7d1f4c1e-0000-4000-8000-000000000001', wabaId: '102030405060708' };

const ring = (current = KEY_A, previous?: string) => parseKeyring(current, previous);

/** Every byte the envelope carries, decoded, so a test can look for the token in it. */
function decoded(envelope: string): string {
  return envelope
    .split('.')
    .slice(2)
    .map((part) => Buffer.from(part, 'base64url').toString('latin1'))
    .join('');
}

function tamper(envelope: string, part: number): string {
  const parts = envelope.split('.');
  const bytes = Buffer.from(parts[part]!, 'base64url');
  bytes[0] = bytes[0]! ^ 0x01;
  parts[part] = bytes.toString('base64url');
  return parts.join('.');
}

describe('seal and unseal', () => {
  it('round-trips a token for the row it was sealed for', () => {
    expect(unseal(seal(TOKEN, ring(), ROW), ring(), ROW)).toBe(TOKEN);
  });

  it('carries the token in no readable form — not as text, not once decoded', () => {
    const envelope = seal(TOKEN, ring(), ROW);
    expect(envelope).not.toContain(TOKEN);
    expect(decoded(envelope)).not.toContain(TOKEN);
    expect(decoded(envelope)).not.toContain(TOKEN.slice(0, 12));
  });

  it('draws a fresh IV every time, so equal tokens never seal alike', () => {
    const ivs = new Set(Array.from({ length: 1000 }, () => seal(TOKEN, ring(), ROW).split('.')[2]));
    expect(ivs.size).toBe(1000);
  });

  it('names its key in the clear, so a page can ask about it without opening it', () => {
    const envelope = seal(TOKEN, ring(), ROW);
    expect(envelopeKeyId(envelope)).toBe(ring().current.id);
    expect(envelopeKeyId('not an envelope')).toBeNull();
  });

  /**
   * The binding. An envelope copied onto another account's row — or left on a
   * row whose WABA id was edited — must not open, or one business's token
   * would send on another's behalf.
   */
  it('refuses another account, another WABA, and another key id in the binding', () => {
    const envelope = seal(TOKEN, ring(), ROW);

    for (const binding of [
      { ...ROW, accountId: '7d1f4c1e-0000-4000-8000-000000000002' },
      { ...ROW, wabaId: '999999999999999' },
    ]) {
      expect(() => unseal(envelope, ring(), binding)).toThrow(CredentialKeyError);
    }

    // The key id is in the authenticated data too: relabelling an envelope
    // with the previous key's id sends it to the other key and fails there.
    const relabelled = envelope.replace(
      `v1.${ring(KEY_A, KEY_B).current.id}.`,
      `v1.${ring(KEY_B).current.id}.`,
    );
    expect(() => unseal(relabelled, ring(KEY_A, KEY_B), ROW)).toThrow(/failed authentication/);
  });

  it('refuses an envelope altered anywhere — IV, ciphertext or tag', () => {
    const envelope = seal(TOKEN, ring(), ROW);
    for (const part of [2, 3, 4]) {
      const run = () => unseal(tamper(envelope, part), ring(), ROW);
      expect(run).toThrow(CredentialKeyError);
      expect(run).toThrow(/failed authentication/);
    }
  });

  it('refuses something that is not an envelope at all', () => {
    expect(() => unseal('v2.abcdef01.x.y.z', ring(), ROW)).toThrow(/not a v1 envelope/);
    expect(() => unseal(`${seal(TOKEN, ring(), ROW)}.extra`, ring(), ROW)).toThrow(
      /not a v1 envelope/,
    );
  });

  it('refuses to seal nothing, or to bind to an empty or ambiguous row', () => {
    expect(() => seal('', ring(), ROW)).toThrow(/empty credential/);
    expect(() => seal(TOKEN, ring(), { ...ROW, wabaId: '' })).toThrow(/binding/);
    expect(() => seal(TOKEN, ring(), { ...ROW, wabaId: '1|2' })).toThrow(/binding/);
  });
});

describe('rotation', () => {
  it('opens what the previous key sealed, and seals only with the current one', () => {
    const old = seal(TOKEN, ring(KEY_A), ROW);
    const rotating = ring(KEY_B, KEY_A);

    expect(unseal(old, rotating, ROW)).toBe(TOKEN);
    expect(envelopeKeyId(seal(TOKEN, rotating, ROW))).toBe(rotating.current.id);
  });

  it('names both key ids — and neither key — when the envelope matches neither', () => {
    const sealed = seal(TOKEN, ring(KEY_A), ROW);
    const other = 'c'.repeat(20) + 'key-c-0123456789abcdef';
    const run = () => unseal(sealed, ring(other, KEY_B), ROW);

    expect(run).toThrow(CredentialKeyError);
    try {
      run();
    } catch (error) {
      const message = (error as Error).message;
      expect((error as CredentialKeyError).reason).toBe('unknown_key');
      expect(message).toContain(ring(KEY_A).current.id);
      expect(message).toContain('WHATSAPP_CREDENTIAL_KEY');
      for (const key of [KEY_A, KEY_B, other]) expect(message).not.toContain(key);
    }
  });

  it('answers which key an envelope is under without opening it', () => {
    const rotating = ring(KEY_B, KEY_A);
    expect(keyStateOf(rotating.current.id, rotating)).toBe('current');
    expect(keyStateOf(ring(KEY_A).current.id, rotating)).toBe('previous');
    expect(keyStateOf('deadbeef', rotating)).toBe('unknown');
    expect(keyStateOf('deadbeef', null)).toBe('no_key');
  });
});

describe('parseKeyring', () => {
  function reasonOf(run: () => unknown): { reason: string; message: string } {
    try {
      run();
    } catch (error) {
      if (error instanceof CredentialKeyError)
        return { reason: error.reason, message: error.message };
      throw error;
    }
    throw new Error('expected a CredentialKeyError');
  }

  it('says the key is unset, naming the variable', () => {
    for (const current of [undefined, '']) {
      const { reason, message } = reasonOf(() => parseKeyring(current, undefined));
      expect(reason).toBe('unset');
      expect(message).toMatch(/^WHATSAPP_CREDENTIAL_KEY is not set/);
    }
  });

  /** The sentences name the variable, never the value — they reach logs and pages. */
  it('refuses a short key and one wrapped in whitespace, without repeating it', () => {
    const short = 'too-short-but-secret';
    const padded = `${KEY_A}\n`;

    for (const [value, pattern] of [
      [short, /shorter than 32 characters/],
      [padded, /whitespace/],
    ] as const) {
      const { reason, message } = reasonOf(() => parseKeyring(value, undefined));
      expect(reason).toBe('malformed');
      expect(message).toMatch(pattern);
      expect(message).toContain('WHATSAPP_CREDENTIAL_KEY');
      expect(message).not.toContain(value.trim());
    }

    const previous = reasonOf(() => parseKeyring(KEY_A, short));
    expect(previous.message).toMatch(/^WHATSAPP_CREDENTIAL_KEY_PREVIOUS is shorter/);
  });

  it('refuses a rotation that changed nothing', () => {
    const { reason, message } = reasonOf(() => parseKeyring(KEY_A, KEY_A));
    expect(reason).toBe('malformed');
    expect(message).toMatch(/holds the same key/);
    expect(message).not.toContain(KEY_A);
  });

  it('derives the same key id from the same secret every time, and a different one otherwise', () => {
    expect(ring(KEY_A).current.id).toBe(ring(KEY_A).current.id);
    expect(ring(KEY_A).current.id).not.toBe(ring(KEY_B).current.id);
    expect(ring(KEY_A).current.id).toMatch(/^[0-9a-f]{8}$/);
    expect(ring(KEY_A).previous).toBeNull();
  });
});
