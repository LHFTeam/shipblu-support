import { logger } from '@/lib/log';

/**
 * The myBlu API's credentials as the environment holds them: `MYBLU_API_TOKEN`
 * and the webhook's `MYBLU_WEBHOOK_SECRET`, each with its `_PREVIOUS` for a
 * rotation. One rule for all four, so "a value under 32 characters counts as
 * unset" cannot mean one thing for the bearer and another for the signature,
 * and so a short `_PREVIOUS` is reported wherever it is read: two copies of the
 * rule drifted, and the webhook's dropped a cut-off previous secret without a
 * word while deliveries carried only the new secret's signature.
 */

const log = logger('api');

/**
 * Below this, a value counts as unset. A minting token is what a leak turns
 * into every user, and a signing secret what lets anybody post as us, so one
 * short enough to have been typed by hand, or cut off when pasted, is treated
 * as no value at all rather than as a weak one. Checked at first use, and never
 * in `lib/env.ts`, where a format rule turns one mistyped value into a console
 * that does not load.
 */
export const MIN_SECRET_CHARS = 32;

const warned = new Set<string>();

/**
 * The value of `name` with any surrounding whitespace taken off, or null when
 * it counts as unset; a value that is set and too short is reported once per
 * process, by name, and never its value or its length.
 *
 * Trimmed because the value is used byte for byte — compared with a bearer,
 * or keyed into an HMAC — and a value pasted into the dashboard with a
 * trailing newline is otherwise a credential nothing can match: every request
 * `401`, every delivery signed under a key the receiver does not hold, and no
 * error pointing at the bytes. No credential here holds whitespace on purpose.
 */
export function usableSecret(name: string, value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length < MIN_SECRET_CHARS) {
    if (!warned.has(name)) {
      warned.add(name);
      log.warn(`${name} is shorter than ${MIN_SECRET_CHARS} characters and counts as unset`);
    }
    return null;
  }
  return trimmed;
}
