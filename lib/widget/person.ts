import { parseIdentity } from './identity-parse';

/**
 * Whether the widget may reopen a stored conversation for whoever is reading
 * now, and whether the session already open still belongs to them.
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
 * reading (`person` on the snippet's `opened` and `closed`, and every
 * `identify`), the token carries a record of the person it was last vouched
 * for, and `judge()` compares the two. It is the one place the rule lives:
 * the resume, the mint and the identity sent after either all ask it, so no
 * two paths can answer differently for the same token and the same reader.
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
 * costs a fresh chat and a wrong resume costs somebody else's conversation. A
 * refusal is not a deletion, though. A token is thrown away only when the page
 * names somebody it cannot be; a page that names nobody, or says less than the
 * record, leaves it in storage for the reader it does belong to.
 */

/**
 * The identifying fields of a host page's identity, each as a SHA-256 digest:
 * the account, the email and the phone. Parsed by the parser the server uses,
 * so `Nour@Merchant.example ` and `nour@merchant.example` are one person on
 * both sides of the wire.
 *
 * Digests because the record outlives the session it describes, and a
 * merchant's plain email has no business sitting in a browser after they
 * signed out — the stale-identity class PR #148's review found in
 * `shipbluSurveysSettings`. Per field rather than one digest of all three, so
 * a dashboard that hands over the email first and the account once its profile
 * request returns is still the same person (`compare`).
 */
export type PersonPrint = { account: string | null; email: string | null; phone: string | null };

/**
 * A page that named a person whose digest could not be taken: Web Crypto
 * exists only in a secure context.
 */
export const UNMATCHED = 'unmatched';

/**
 * What the host page said about who is reading:
 * - `undefined`: it did not say — a snippet cached from before it could
 *   (`embed.js` is cached for five minutes), which resumes as before;
 * - `null`: it names nobody, as the help centre does;
 * - a print: that person;
 * - `UNMATCHED`: somebody, but nothing here can tell who, so it opens nothing
 *   stored and vouches for nothing.
 */
export type HostStatement = PersonPrint | typeof UNMATCHED | null | undefined;

async function digest(value: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** The statement a host message makes; `carried` is whether it had the property at all. */
export async function statementOf(person: unknown, carried: boolean): Promise<HostStatement> {
  if (!carried) return undefined;
  const identity = parseIdentity(person);
  if (!identity) return null;

  const { accountId, email, phone } = identity;
  if (!accountId && !email && !phone) return null;

  // Each field under its own name, so an account number and a phone that
  // happen to share digits are not the same field.
  const [account, mail, tel] = await Promise.all([
    accountId ? digest(`account:${accountId}`) : null,
    email ? digest(`email:${email}`) : null,
    phone ? digest(`phone:${phone}`) : null,
  ]);
  if ((accountId && !account) || (email && !mail) || (phone && !tel)) return UNMATCHED;
  return { account, email: mail, phone: tel };
}

/**
 * The same person, somebody else, or a page saying less than the record — and
 * "less" is not "somebody else": a dashboard that sends the email before the
 * account is the same merchant, half-said.
 *
 * - Any field both carry that differs is somebody else. The phone counts only
 *   when neither side has an email, the preference `identityKey` makes, so a
 *   merchant who edits their phone is still themselves.
 * - A field the record has and the page does not say yet is `less`.
 * - Otherwise the page says at least what the record says. It is the same
 *   person when a field naming a *person* (the email, or the phone where there
 *   is no email) agrees; agreeing on the account alone is only the same person
 *   when the page adds no person to it. A record vouched for by the account
 *   alone, met by that account and an email, could be any of the account's
 *   people — two colleagues of one merchant, the case this exists for.
 */
function compare(stated: PersonPrint, recorded: PersonPrint): 'same' | 'other' | 'less' {
  const byPhone = !stated.email && !recorded.email;
  const differs = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;
  if (
    differs(stated.account, recorded.account) ||
    differs(stated.email, recorded.email) ||
    (byPhone && differs(stated.phone, recorded.phone))
  ) {
    return 'other';
  }

  const unsaid = (a: string | null, b: string | null) => b !== null && a === null;
  if (
    unsaid(stated.account, recorded.account) ||
    unsaid(stated.email, recorded.email) ||
    (byPhone && unsaid(stated.phone, recorded.phone))
  ) {
    return 'less';
  }

  const personAgrees =
    (stated.email !== null && stated.email === recorded.email) ||
    (byPhone && stated.phone !== null && stated.phone === recorded.phone);
  if (personAgrees) return 'same';
  const addsPerson =
    (stated.email !== null && recorded.email === null) ||
    (byPhone && stated.phone !== null && recorded.phone === null);
  return addsPerson ? 'other' : 'same';
}

/**
 * Where the token being judged stands: still in storage, waiting to be
 * reopened; reopened from storage in this document; or minted in this
 * document, for whoever was reading then.
 */
export type Standing = 'stored' | 'resumed' | 'minted';

/**
 * - `open`: reopen it, or keep the session going, and record `record` against
 *   it when there is one — the first record, or one the page has added to;
 * - `leave`: do not reopen it, and leave it in storage for its own reader;
 * - `discard`: throw it away, because the reader is somebody it cannot be.
 */
export type Judgement = { verdict: 'open' | 'leave' | 'discard'; record: PersonPrint | null };

const open = (record: PersonPrint | null = null): Judgement => ({ verdict: 'open', record });
const leave: Judgement = { verdict: 'leave', record: null };
const discard: Judgement = { verdict: 'discard', record: null };

/**
 * The rule.
 *
 * A token with no record is refused to a page that names somebody. Every
 * token left before this check existed is one of those, and every one of them
 * survived a sign-out that should have removed it; reopening them and
 * labelling them with whoever reads next would be the leak once more, on every
 * shared machine. The one exception is a token minted in this document, which
 * belongs to whoever was reading when it was minted: the page naming them now
 * vouches for it. A token with a record is not reopened for a page that names
 * nobody, because other pages on the same site share the frame's storage
 * partition and an anonymous page must not open a merchant's conversation —
 * but it stays, since its merchant may be back on the dashboard in a minute.
 */
export function judge(
  stated: HostStatement,
  recorded: PersonPrint | null,
  standing: Standing,
): Judgement {
  if (stated === undefined) return open();

  if (standing === 'stored') {
    if (stated === null) return recorded ? leave : open();
    if (stated === UNMATCHED) return leave;
    if (!recorded) return discard;
    const verdict = compare(stated, recorded);
    if (verdict === 'same') return open(stated);
    return verdict === 'less' ? leave : discard;
  }

  // A session already open in this document. Naming nobody now is not a
  // change of person — that is `clear()`, which says so itself.
  if (stated === null) return open();
  if (stated === UNMATCHED) return recorded || standing === 'resumed' ? discard : open();
  if (!recorded) return standing === 'minted' ? open(stated) : discard;
  const verdict = compare(stated, recorded);
  if (verdict === 'same') return open(stated);
  return verdict === 'less' ? open() : discard;
}
