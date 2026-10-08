import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyState } from './credential-status';

/**
 * Sealing a WhatsApp business token for storage, and opening it again.
 *
 * The one credential this database holds. Everything else Meta-shaped lives in
 * the environment and is named from a row, so a dump contains nothing usable;
 * a token minted by Embedded Signup has no human holding it and no variable to
 * be named by, so it is stored — sealed, under a key the database never sees.
 * `plans/whatsapp-coexistence.md` has the decision and the alternatives it
 * turned down.
 *
 * Modelled on `lib/auth/invite-token.ts`, with two things that one does not
 * need. **A key id**, in the envelope and in the authenticated data, because
 * this key must rotate on its own — `APP_SECRET` signs reply tokens sitting in
 * customers' mailboxes and is effectively never changed, which is why the key
 * is not derived from it. **A binding to the row**: the authenticated data
 * names the table, the account and the WABA, so an envelope copied onto another
 * account's row, or left on a row whose WABA id was edited, fails to open
 * rather than sending one business's credential on another's behalf.
 *
 * AES-256-GCM, a random 96-bit IV per seal and the full 128-bit tag. A key is
 * stretched from the variable through HKDF rather than used as raw bytes, so
 * any high-entropy string of 32 characters or more is a key, and the format
 * `openssl rand -base64 32` prints is simply one of them.
 *
 * Pure: the caller reads the variables (`lib/whatsapp/credentials.ts`) and this
 * module never touches `env()`, so a test can hold two keyrings at once.
 */

const FORMAT = 'v1';
const SALT = 'whatsapp-credential';
const INFO = 'shipblu-support/whatsapp-credential/v1';
/** Named in the authenticated data: an envelope means nothing outside its table. */
const TABLE = 'whatsapp_account_credentials';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID = /^[0-9a-f]{8}$/;

/**
 * Shorter than this is not a key, whatever it looks like. `openssl rand
 * -base64 32` prints 44 characters; a person choosing a passphrase is the case
 * this exists to refuse.
 */
const MIN_SECRET_LENGTH = 32;

export const CURRENT_KEY_VARIABLE = 'WHATSAPP_CREDENTIAL_KEY';
export const PREVIOUS_KEY_VARIABLE = 'WHATSAPP_CREDENTIAL_KEY_PREVIOUS';

type Key = { id: string; bytes: Buffer };

/** The key that seals, and the one a rotation is moving away from. */
export type Keyring = { current: Key; previous: Key | null };

/** The row an envelope belongs to. Both halves are in the authenticated data. */
export type EnvelopeBinding = { accountId: string; wabaId: string };

/**
 * Why a credential could not be sealed or opened.
 *
 * A class of its own so a caller can tell "the key is wrong" from "Meta said
 * no": the first is fixed on Render, the second by signing in again, and a
 * sentence that sends somebody to the wrong one costs them the afternoon. Every
 * message names the variable and the key ids, and never a value.
 */
export class CredentialKeyError extends Error {
  constructor(
    readonly reason: 'unset' | 'malformed' | 'unknown_key' | 'undecryptable',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialKeyError';
  }
}

function deriveKey(secret: string): Key {
  const bytes = Buffer.from(hkdfSync('sha256', secret, SALT, INFO, KEY_BYTES));
  // A hash of the derived key, so the id identifies a key without being one:
  // 32 bits of a SHA-256 says nothing usable about the 256 it was taken from.
  return { id: createHash('sha256').update(bytes).digest('hex').slice(0, 8), bytes };
}

function checkSecret(name: string, value: string): void {
  if (value !== value.trim()) {
    throw new CredentialKeyError(
      'malformed',
      `${name} begins or ends with whitespace. Paste the key again without it — a ` +
        `trailing newline is a different key, and every service must derive the same one.`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new CredentialKeyError(
      'malformed',
      `${name} is shorter than ${MIN_SECRET_LENGTH} characters, which is not a key. ` +
        `Generate one with \`openssl rand -base64 32\`.`,
    );
  }
}

/**
 * The keyring the two variables describe.
 *
 * Validated here, at first use, and not in `lib/env.ts`: `env()` parses the
 * whole schema on every page and action, so a format rule there would turn one
 * mistyped key into a console that does not load at all, rather than into a
 * WhatsApp connection that says what is wrong with it.
 */
export function parseKeyring(current: string | undefined, previous: string | undefined): Keyring {
  if (!current) {
    throw new CredentialKeyError(
      'unset',
      `${CURRENT_KEY_VARIABLE} is not set, so no stored WhatsApp credential can be sealed or ` +
        `read. Generate one with \`openssl rand -base64 32\` and add it to this ` +
        `environment's group.`,
    );
  }
  checkSecret(CURRENT_KEY_VARIABLE, current);
  const currentKey = deriveKey(current);

  if (!previous) return { current: currentKey, previous: null };

  checkSecret(PREVIOUS_KEY_VARIABLE, previous);

  // A rotation that changed nothing. Refused rather than tolerated, because the
  // person who set it believes they rotated, and the reseal job would report
  // every row as already current — which reads as success.
  if (previous === current) {
    throw new CredentialKeyError(
      'malformed',
      `${PREVIOUS_KEY_VARIABLE} holds the same key as ${CURRENT_KEY_VARIABLE}. During a ` +
        `rotation the previous variable holds the key being retired and the current one ` +
        `the new key; outside one, leave ${PREVIOUS_KEY_VARIABLE} unset.`,
    );
  }

  const previousKey = deriveKey(previous);

  // Two different keys whose ids collide — one chance in four billion, and the
  // one case where an id would open an envelope with the wrong key and report
  // tampering. Cheaper to refuse than to explain later.
  if (previousKey.id === currentKey.id) {
    throw new CredentialKeyError(
      'malformed',
      `${CURRENT_KEY_VARIABLE} and ${PREVIOUS_KEY_VARIABLE} are different keys with the same ` +
        `id (${currentKey.id}). Generate another current key.`,
    );
  }

  return { current: currentKey, previous: previousKey };
}

function additionalData(keyId: string, binding: EnvelopeBinding): Buffer {
  // A separator inside a field would let two different bindings serialise to
  // the same bytes. Neither field can hold one — a uuid and a numeric WABA id —
  // and this says so rather than assuming it.
  for (const value of [binding.accountId, binding.wabaId]) {
    if (!value || value.includes('|')) {
      throw new Error('an envelope binding must be a non-empty account id and WABA id');
    }
  }
  return Buffer.from([FORMAT, keyId, TABLE, binding.accountId, binding.wabaId].join('|'), 'utf8');
}

/** Seals `plaintext` under the current key, bound to `binding`. */
export function seal(plaintext: string, keyring: Keyring, binding: EnvelopeBinding): string {
  if (!plaintext) throw new Error('refusing to seal an empty credential');

  const key = keyring.current;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  cipher.setAAD(additionalData(key.id, binding));

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT,
    key.id,
    iv.toString('base64url'),
    encrypted.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/** The key id an envelope was sealed under, read without opening it. */
export function envelopeKeyId(envelope: string): string | null {
  const parts = envelope.split('.');
  return parts.length === 5 && parts[0] === FORMAT && KEY_ID.test(parts[1]!) ? parts[1]! : null;
}

/**
 * Opens an envelope with whichever key it names.
 *
 * Throws rather than answering null, unlike `unsealInviteToken`. A missing
 * invite link costs an admin a copy button; a credential that silently fails
 * to open would let a caller fall back to some other token and send one
 * business's messages with another's — the "went out from the wrong WABA"
 * failure `lib/whatsapp/accounts.ts` is written around.
 */
export function unseal(envelope: string, keyring: Keyring, binding: EnvelopeBinding): string {
  const parts = envelope.split('.');
  const keyId = envelopeKeyId(envelope);

  if (keyId === null) {
    throw new CredentialKeyError(
      'undecryptable',
      'the stored credential is not a v1 envelope, so it was not written by this module',
    );
  }

  const key =
    keyId === keyring.current.id
      ? keyring.current
      : keyId === keyring.previous?.id
        ? keyring.previous
        : null;

  if (!key) {
    throw new CredentialKeyError(
      'unknown_key',
      `the stored credential was sealed under key ${keyId}, and neither ` +
        `${CURRENT_KEY_VARIABLE} (${keyring.current.id}) nor ${PREVIOUS_KEY_VARIABLE} ` +
        `(${keyring.previous?.id ?? 'unset'}) is that key`,
    );
  }

  // Outside the try: a malformed binding is the caller's bug, and reporting it
  // as a tampered envelope would send somebody looking for an attacker.
  const aad = additionalData(keyId, binding);
  const iv = Buffer.from(parts[2]!, 'base64url');
  const encrypted = Buffer.from(parts[3]!, 'base64url');
  const tag = Buffer.from(parts[4]!, 'base64url');

  try {
    if (iv.length !== IV_BYTES || encrypted.length === 0 || tag.length !== TAG_BYTES) {
      throw new Error('wrong length');
    }
    const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialKeyError(
      'undecryptable',
      `the stored credential sealed under key ${keyId} failed authentication — it was ` +
        `altered, or it belongs to another account or business account`,
    );
  }
}

/** Whether this process holds the key an envelope names, without opening it. */
export function keyStateOf(keyId: string, keyring: Keyring | null): KeyState {
  if (!keyring) return 'no_key';
  if (keyId === keyring.current.id) return 'current';
  if (keyId === keyring.previous?.id) return 'previous';
  return 'unknown';
}
