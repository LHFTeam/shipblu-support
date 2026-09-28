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

export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored is nothing to remove.
  }
}
