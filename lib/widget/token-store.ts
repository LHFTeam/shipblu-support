/**
 * Where the widget keeps the visitor's token between page loads.
 *
 * `localStorage` can refuse outright. The widget runs as a third-party iframe
 * on a merchant's site, and a browser blocking third-party storage throws
 * `SecurityError` from the `localStorage` property itself, before any method is
 * reached — Safari and Firefox do this by default for some embeds, and so does
 * every browser in a private window with the setting on. Unguarded, that
 * throw killed the resume effect and `ensureSession` alike, so the visitor
 * could not start a conversation at all.
 *
 * So every access is its own `try`, and a refusal reads as "no stored token".
 * The session still works for as long as the page is open, because the shell
 * holds the token in state; what is lost is only resuming it after a reload,
 * which is the one thing the storage was for.
 */

const STORAGE_KEY = 'shipblu.widget.token';

export function readToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Kept in memory by the caller; only a reload forgets it.
  }
}

/**
 * Who a token was last vouched for, as `lib/widget/person.ts`'s digest, kept
 * beside the token and bound to it.
 *
 * Bound by carrying the token itself: a record answers only for the token it
 * was written with, so one left by an older frame in another tab, or by a
 * token since replaced, cannot vouch for the next one. The token is already
 * stored in plain text under the key above, so repeating it here exposes
 * nothing that was not there; the person is a digest, never the email.
 *
 * The key is never renamed: a frame from before a rename would read every
 * record as missing and refuse every stored conversation.
 */
const PERSON_KEY = 'shipblu.widget.person';

export function readTokenPerson(token: string): string | null {
  try {
    const raw = localStorage.getItem(PERSON_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as { v?: unknown; token?: unknown; person?: unknown } | null;
    if (!record || record.v !== 1 || record.token !== token) return null;
    return typeof record.person === 'string' && record.person ? record.person : null;
  } catch {
    return null;
  }
}

export function writeTokenPerson(token: string, person: string): void {
  try {
    localStorage.setItem(PERSON_KEY, JSON.stringify({ v: 1, token, person }));
  } catch {
    // Unrecorded, the token is refused at the next identified open: a fresh
    // chat, which is the safe side of a storage that will not keep anything.
  }
}

/** Both keys: a record outliving its token would vouch for nothing, and is noise. */
export function clearToken(): void {
  for (const key of [STORAGE_KEY, PERSON_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing stored is nothing to remove.
    }
  }
}
