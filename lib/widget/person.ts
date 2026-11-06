import { parseIdentity } from './identity-parse';

/**
 * Whether the widget may reopen a stored conversation for whoever is reading
 * now.
 *
 * The visitor token lives in the widget origin's storage, so it outlives the
 * host page's session, and a host page's `clear()` at sign-out is the only
 * thing that throws it away. On the merchant dashboard that clear never landed:
 * the shell's unmount took the panel down a couple of milliseconds after it, a
 * panel never opened in that page load could not be told at all before the
 * Auth0 redirect, and a session that simply expired never called it
 * (`docs/PROJECT-STATE.md` §6.111). The next person at that browser then
 * opened the previous one's conversation, because the frame resumed the stored
 * token the moment it mounted and only heard who was reading afterwards.
 *
 * So the frame decides before it resumes. The host page states the person
 * reading (`person` on the snippet's `opened` and `closed`), the token carries
 * a record of the person it was last vouched for, and the two must agree.
 * Deciding at the next open covers every way the clear can go missing, which
 * a fix at sign-out cannot: by the time the next person opens the panel,
 * whatever happened at sign-out has happened.
 *
 * **This is a different question from the server's `identityKey`**, and the
 * difference is the point. That key is account-first, so two colleagues of one
 * merchant share one contact rather than splitting an account's history in
 * two (`lib/widget/identity.ts`). This asks whether the person at this browser
 * has changed since the token was vouched for, which is what `clear()` has
 * always promised a host page: a colleague signing in after another starts
 * clean.
 *
 * An unsigned statement may refuse a resume and never grants one beyond what
 * the token already had: anyone can type somebody's email into devtools, and
 * all it buys them is a fresh chat. Any doubt refuses, because a wrong refusal
 * costs a fresh chat and a wrong resume costs somebody else's conversation.
 */

/**
 * The identifying half of a host page's identity, as one string: the account,
 * the email, and the phone only when there is no email — the same last resort
 * `identityKey` uses. Parsed by the parser the server uses, so a host page that
 * sends `Nour@Merchant.example ` and one that sends `nour@merchant.example` are
 * the same person on both sides of the wire.
 *
 * One key rather than its halves compared one by one: half by half resumes in
 * exactly the doubtful cases, such as two colleagues of one account where one
 * of them has no email.
 */
export function personKey(raw: unknown): string | null {
  const identity = parseIdentity(raw);
  if (!identity) return null;

  const { accountId, email, phone } = identity;
  if (!accountId && !email && !phone) return null;

  return JSON.stringify([accountId, email, email ? null : phone]);
}

/**
 * The key as a SHA-256 digest, because the record outlives the session it
 * describes and a merchant's plain email has no business sitting in a browser
 * after they signed out — the stale-identity class PR #148's review found in
 * `shipbluSurveysSettings`. Null for no key, and for a browser without Web
 * Crypto, which outside a secure context is every browser; the caller treats
 * that as a person nobody can match rather than as nobody.
 */
export async function personDigest(key: string | null): Promise<string | null> {
  if (key === null) return null;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;

  try {
    const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(key));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * What the host page said about who is reading:
 * - `undefined`: it did not say — a snippet cached from before it could
 *   (`embed.js` is cached for five minutes), which resumes as before;
 * - `null`: it names nobody, as the help centre does;
 * - a digest: that person. `UNMATCHED` is a person whose digest could not be
 *   taken, which matches no record and so resumes nothing.
 */
export type HostStatement = string | null | undefined;

export const UNMATCHED = '';

/** The statement a `person` field makes, or `undefined` for a message that carried none. */
export async function statementOf(person: unknown, carried: boolean): Promise<HostStatement> {
  if (!carried) return undefined;
  const key = personKey(person);
  if (key === null) return null;
  return (await personDigest(key)) ?? UNMATCHED;
}

/**
 * The decision.
 *
 * A token with no record is refused for a page that names somebody. Every
 * token left before this check existed is one of those, and every one of them
 * survived a sign-out that should have removed it; resuming them and labelling
 * them with whoever reads next would be the leak once more, on every shared
 * machine. A token with a record is refused for a page that names nobody,
 * because other pages on the same site share the frame's storage partition and
 * an anonymous page must not open a merchant's conversation.
 */
export function mayResume(stated: HostStatement, recorded: string | null): boolean {
  if (stated === undefined) return true;
  if (stated === null) return recorded === null;
  return stated !== UNMATCHED && recorded === stated;
}
