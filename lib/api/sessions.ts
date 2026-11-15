import { and, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { apiSessions, contactIdentities, contacts, type ApiSessionEndReason } from '@/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { findIdentity, pendingApiContact, resolveApiContactIn } from '@/lib/tickets/contacts';
import { afterRelease, releaseTickets, releasesTickets } from './release';

/**
 * The myBlu API's sessions (`plans/myblu-ticket-api.md`, _The session_): minted
 * by myBlu's backend on the server plane, presented by the app on the client
 * plane, ended by either. `api_sessions` (`db/schema/api.ts`) says why the row
 * looks as it does; this module is everything that reads or writes it.
 */

/** Twenty-four hours from minting, fixed, with no refresh. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** How long a row outlives its expiry, as the record of who was vouched for. */
const KEPT_AFTER_EXPIRY_DAYS = 30;

/**
 * `sbu_` and then `generateToken()`, hashed whole. The prefix says what a
 * string is wherever it turns up — a crash report, a support ticket, a secret
 * scanner — and the shape is checked before anything is read, so a bearer that
 * cannot be one of ours costs no query.
 */
const TOKEN_PREFIX = 'sbu_';
const TOKEN_SHAPE = /^sbu_[A-Za-z0-9_-]{43}$/;

/**
 * The account's identity is `('api', 'myblu:<externalUserId>')`: namespaced, so
 * a second caller of this API — which would be its own decision — gets a
 * keyspace of its own rather than sharing myBlu's.
 */
const IDENTIFIER_PREFIX = 'myblu:';

function mybluIdentifier(externalUserId: string): string {
  return `${IDENTIFIER_PREFIX}${externalUserId}`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The account's advisory lock, for the rest of the transaction, taken first by
 * a mint and by a revoke, so the two are ordered. Without it a revoke's
 * `UPDATE` cannot see a session a mint has inserted and not yet committed, and
 * does not wait for it: the revoke answers `204`, the mint commits, and its
 * session lives for a day after a "sign out everywhere". Keyed on the
 * identifier rather than the identity's row, because an account's first mint
 * has no committed identity to lock, and a revoke racing it would find none.
 * A transaction lock, as AGENTS.md asks of every advisory lock on the pooler.
 * It is always the first lock its transaction takes: the mint takes it before
 * the contact's row lock and the number's lock, so no two mints, and no mint
 * and revoke, can wait on each other in opposite orders.
 */
async function lockAccount(tx: Tx, identifier: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`api-account:${identifier}`}::text, 0))`,
  );
}

/** Who is asking, as the session says: never a field of the request. */
export type Caller = {
  identityId: string;
  /** Read through the identity on this request, never stored: a merge moves it. */
  contactId: string;
  externalUserId: string;
  /** The presented token's hash, so `DELETE /session` ends this one and nothing else. */
  tokenHash: string;
  /**
   * The app the session was minted for, as its backend passed it on: labels
   * for an agent to read, which `opened_from_app` falls back on when the
   * request's `ShipBlu-Client` does not name them. Never a credential.
   */
  platform: string;
  appVersion: string;
};

export type MintInput = {
  externalUserId: string;
  /** The vouched-for phone as digits, without its plus. */
  phone: string;
  name: string | null;
  platform: string;
  appVersion: string;
  /** The minting request's `X-Forwarded-For` chain (`forwardedChain`), or null when none came. */
  forwardedFor: string | null;
  now: Date;
};

export type MintOutcome =
  | { kind: 'minted'; token: string; expiresAt: Date; identityId: string }
  | { kind: 'blocked'; identityId: string };

/**
 * A new session for one account, on every call: the backend never caches one,
 * since a cached token is the one just refused.
 *
 * The account's identity and contact are resolved first (`pendingApiContact`,
 * then `resolveApiContactIn` in the transaction), and the session written in
 * the same transaction, behind the account's lock (`lockAccount`), so a revoke
 * either sees this session or comes after it. A blocked contact gets no
 * session — `403 blocked` is the answer the backend relays to its app, whose
 * SDK then stops asking rather than minting a row no call could use on every
 * foreground. The identity a first mint made for it stays, as any channel's
 * identity does for a blocked contact: the next mint finds it and is refused
 * the same way.
 *
 * The contact is read through the identity, in the transaction, never by the
 * id `pendingApiContact` read before it: a merge committed between the two
 * re-points the identity to the survivor and stamps the old contact deleted,
 * and read by the old id the account was refused `403 blocked`, which its SDK
 * holds until the app restarts. An identity gone by then was purged with its
 * contact mid-mint: that throws, a `500` the backend retries, and the retry
 * resolves the account afresh.
 *
 * A session that is minted brings the backend's name for the user to the
 * contact and the identity (`keepNameCurrent`), so the console and the
 * out-of-hours greeting follow a name changed in the app.
 */
export async function mintSession(input: MintInput): Promise<MintOutcome> {
  const identifier = mybluIdentifier(input.externalUserId);
  const pending = await pendingApiContact({
    identifier,
    phone: input.phone,
    name: input.name,
  });

  return db.transaction(async (tx): Promise<MintOutcome> => {
    await lockAccount(tx, identifier);
    const { identityId } = await resolveApiContactIn(tx, pending);

    const [contact] = await tx
      .select({
        id: contacts.id,
        isBlocked: contacts.isBlocked,
        deletedAt: contacts.deletedAt,
        name: contacts.name,
        displayName: contactIdentities.displayName,
      })
      .from(contactIdentities)
      .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
      .where(eq(contactIdentities.id, identityId))
      .limit(1);
    if (!contact) throw new Error('The account was purged while its session was minted');
    if (refused(contact)) return { kind: 'blocked', identityId };
    await keepNameCurrent(tx, contact, identityId, input.name);

    const token = `${TOKEN_PREFIX}${generateToken()}`;
    const expiresAt = new Date(input.now.getTime() + SESSION_TTL_SECONDS * 1000);
    await tx.insert(apiSessions).values({
      tokenHash: hashToken(token),
      identityId,
      phone: input.phone,
      platform: input.platform,
      appVersion: input.appVersion,
      forwardedFor: input.forwardedFor,
      createdAt: input.now,
      expiresAt,
    });
    return { kind: 'minted', token, expiresAt, identityId };
  });
}

/**
 * The backend's name for the user, written to the contact and to this identity
 * wherever it differs: the owner's decision of 2026-11-15
 * (`plans/myblu-ticket-api.md`, _Identity_). A name changed in the app reaches
 * the console, and the out-of-hours greeting, at the next mint, within a day.
 * It renames the contact on every channel, a WhatsApp contact the account
 * joined included, and replaces a name an agent typed: myBlu's account is
 * taken as the better word on what the person is called.
 *
 * It was the other way first — used only for a contact the mint created —
 * because a number that changed hands joins the new holder to a contact named
 * for the previous one, and an agent's correction would be lost. The owner
 * weighed both: numbers rarely change hands, and the new holder's own name
 * replaces the old one once they set it in the app.
 *
 * A blank or absent name changes nothing, since the backend saying nothing is
 * not the user clearing their name. Each statement runs only where the names
 * the mint already read differ — the daily mint of a user whose name agrees,
 * the usual case, sends none, inside a transaction that holds the account's
 * lock and a pooled connection — and its `WHERE` names the difference too, so
 * an agent's edit landing since that read is still compared, not overwritten
 * blind. After the blocked check, so a refused mint writes nothing to the
 * contact.
 */
async function keepNameCurrent(
  tx: Tx,
  held: { id: string; name: string | null; displayName: string | null },
  identityId: string,
  given: string | null,
): Promise<void> {
  const name = given?.trim();
  if (!name) return;
  if (held.name !== name) {
    await tx
      .update(contacts)
      .set({ name })
      .where(and(eq(contacts.id, held.id), or(isNull(contacts.name), ne(contacts.name, name))));
  }
  if (held.displayName !== name) {
    await tx
      .update(contactIdentities)
      .set({ displayName: name })
      .where(
        and(
          eq(contactIdentities.id, identityId),
          or(isNull(contactIdentities.displayName), ne(contactIdentities.displayName, name)),
        ),
      );
  }
}

/**
 * A contact the API refuses: blocked, as `getSessionCustomer` refuses one, or
 * deleted. Nothing deletes a contact an `api` identity hangs off without moving
 * the identity — a merge re-points it to the survivor, a purge takes it with
 * the contact — so, read through the identity as both readers here read it,
 * the second is a guard on a row edited by hand, answered as the first is, so
 * the app stops rather than minting again on every foreground.
 */
function refused(contact: { isBlocked: boolean; deletedAt: Date | null }): boolean {
  return contact.isBlocked || contact.deletedAt !== null;
}

export type SessionLookup =
  | { kind: 'live'; caller: Caller }
  /** No bearer of ours, a malformed one, or none this server holds: unknown, swept or revoked. */
  | { kind: 'unauthenticated' }
  /** A row that exists and is past its `expires_at`. */
  | { kind: 'expired' }
  /**
   * A row that is live but whose contact may not use support. It carries the
   * token's hash so `DELETE /session` can still end it (`endingPlane`).
   */
  | { kind: 'blocked'; identityId: string; tokenHash: string };

/**
 * The session a bearer names, read with its identity and that identity's
 * contact in one statement, on every request and never cached: a revoke, a
 * block or a merge is the next request's answer. A read, not a lock, so the
 * joins are safe (AGENTS.md's rule is about a read that locks), and it writes
 * nothing: the life is fixed, so there is no `last_used_at` to move.
 */
export async function lookupSession(token: string, now: Date): Promise<SessionLookup> {
  if (!TOKEN_SHAPE.test(token)) return { kind: 'unauthenticated' };
  const tokenHash = hashToken(token);

  const [row] = await db
    .select({
      identityId: apiSessions.identityId,
      expiresAt: apiSessions.expiresAt,
      revokedAt: apiSessions.revokedAt,
      platform: apiSessions.platform,
      appVersion: apiSessions.appVersion,
      identifier: contactIdentities.identifier,
      contactId: contacts.id,
      isBlocked: contacts.isBlocked,
      deletedAt: contacts.deletedAt,
    })
    .from(apiSessions)
    .innerJoin(contactIdentities, eq(contactIdentities.id, apiSessions.identityId))
    .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(and(eq(apiSessions.tokenHash, tokenHash), eq(contactIdentities.channel, 'api')))
    .limit(1);

  // Revoked before expired: a row somebody ended says so whatever its age.
  if (!row || row.revokedAt) return { kind: 'unauthenticated' };
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
  if (!row.identifier.startsWith(IDENTIFIER_PREFIX)) return { kind: 'unauthenticated' };
  if (refused(row)) return { kind: 'blocked', identityId: row.identityId, tokenHash };

  return {
    kind: 'live',
    caller: {
      identityId: row.identityId,
      contactId: row.contactId,
      externalUserId: row.identifier.slice(IDENTIFIER_PREFIX.length),
      tokenHash,
      platform: row.platform,
      appVersion: row.appVersion,
    },
  };
}

/**
 * The caller's account lock, for the rest of the transaction, and the caller as
 * it stands under it: null when the session the request presented is no longer
 * live — revoked or expired, read on the transaction — and otherwise the caller
 * with its contact read again and held (`holdRequester`).
 *
 * Taken first by every transaction of the client plane that writes — opening
 * a ticket, writing on one and marking one read (`createApiTicket`,
 * `sendApiMessage`, `markTicketRead`) — so a write and a revoke for one
 * account are ordered as a mint and a revoke are.
 * Without it, a revoke with `account_deleted` deletes the account's ownership
 * rows while a create is between its gate and its commit, and the create's row,
 * not yet committed, is neither seen nor waited for: the deleted account's
 * newest ticket stays in the app. With it, a create that comes first commits
 * before the revoke reads, and its row goes with the rest; a create that comes
 * after finds its session revoked here and writes nothing. It also serialises
 * one account's creates, which is what lets the ten-open count hold.
 */
export async function holdAccount(tx: Tx, caller: Caller, now: Date): Promise<Caller | null> {
  await lockAccount(tx, mybluIdentifier(caller.externalUserId));
  const [live] = await tx
    .select({ one: sql`1` })
    .from(apiSessions)
    .where(
      and(
        eq(apiSessions.tokenHash, caller.tokenHash),
        isNull(apiSessions.revokedAt),
        gt(apiSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return live ? holdRequester(tx, caller) : null;
}

/**
 * How many times `holdRequester` follows its identity to another contact. A
 * merge re-points every identity past the contact it folds, so one hop is a
 * merge and a second is a merge of the survivor landing in the same moment.
 */
const REQUESTER_HOPS = 3;

/**
 * The caller with the contact its identity names now, read on the transaction
 * and locked `FOR KEY SHARE` until it ends — the contact a write in that
 * transaction files under and authors as — or null when the identity is gone
 * (purged with its contact) or names a contact deleted with no survivor.
 *
 * The gate read the contact before the transaction began. A contact merge
 * committed since re-points the identity to the survivor, moves the folded
 * contact's tickets and messages, and stamps it deleted, but leaves the row,
 * so a foreign key still accepts it: a ticket written under the id the gate
 * read lands on the tombstone after the merge has moved everything else, and
 * from the next request on `ownedTicket` reads the survivor and never finds it
 * — answered `201` and then `404` for good. Read here, a merge already
 * committed is followed; and the lock makes one that has not begun wait, since
 * its `FOR UPDATE` conflicts with this share, so it commits after this
 * transaction and moves what it wrote. It is the mint's rule (`mintSession`
 * reads the contact through the identity in its transaction) for the writes
 * that come after it.
 *
 * Two statements, never a lock through a join: the identity's `contact_id` is
 * what a merge changes, and a locked read joined through it re-checks the
 * newest contact row against the identity it read before waiting (AGENTS.md,
 * _A read that locks a row…_). So the lock names the id just read and asks it
 * to be neither merged nor deleted: a merge holding the row when this asked
 * commits first, the re-check finds the row folded and answers nothing, and
 * the identity, read again in a statement of its own, names the survivor.
 *
 * Contact, then ticket — the order a merge and a contact's purge lock in, the
 * contacts first — so a send holding a ticket's row never waits on a merge
 * that is waiting for that row.
 */
async function holdRequester(tx: Tx, caller: Caller): Promise<Caller | null> {
  let followed: string | null = null;
  for (let hop = 0; hop < REQUESTER_HOPS; hop++) {
    const [identity] = await tx
      .select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(eq(contactIdentities.id, caller.identityId))
      .limit(1);
    // Gone, or still naming a contact the lock refused: deleted with no survivor.
    if (!identity || identity.contactId === followed) return null;

    const [held] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.id, identity.contactId),
          isNull(contacts.mergedIntoContactId),
          isNull(contacts.deletedAt),
        ),
      )
      .for('key share');
    if (held) return { ...caller, contactId: held.id };
    followed = identity.contactId;
  }
  return null;
}

/**
 * The caller with the contact its identity names now, read through the
 * identity on a short transaction of its own, for a replay: what an
 * `Idempotency-Key` was spent on is read through `ownedTicket`, which compares
 * the ticket's requester with the caller's contact, and the gate's contact is
 * stale exactly when a merge landed during the request (`replay` in
 * `tickets.ts`). Null as `holdRequester` is.
 */
export async function requesterNow(caller: Caller): Promise<Caller | null> {
  return db.transaction((tx) => holdRequester(tx, caller));
}

/**
 * What `DELETE /session` runs: the presented token and nothing else, stamped
 * rather than deleted, so the row still says who was vouched for. The
 * statement itself, which the route awaits, so a test can read its parameters
 * back (AGENTS.md, _Tests_) from the one name that runs it.
 */
export function endSession(tokenHash: string, now: Date) {
  return db
    .update(apiSessions)
    .set({ revokedAt: now, revokeReason: 'ended' satisfies ApiSessionEndReason })
    .where(and(eq(apiSessions.tokenHash, tokenHash), isNull(apiSessions.revokedAt)));
}

/**
 * The statement a revoke runs: every live session of one identity, on every
 * device, stamped with the reason. "Live" is unrevoked and unexpired, so an
 * earlier reason is never overwritten and an expired row keeps saying it ran
 * out. Run on the revoke's transaction; exported for the same test.
 */
export function revokeStatement(
  executor: typeof db | Tx,
  identityId: string,
  reason: ApiSessionEndReason,
  now: Date,
) {
  return executor
    .update(apiSessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(
      and(
        eq(apiSessions.identityId, identityId),
        isNull(apiSessions.revokedAt),
        gt(apiSessions.expiresAt, now),
      ),
    );
}

/**
 * `POST /sessions/revoke`: every session of the account, on every device. An
 * account this server does not know revokes nothing and is answered as one it
 * does, so the call cannot be used to ask who is.
 *
 * Behind the account's lock (`lockAccount`), and the identity read after it, on
 * the transaction: a mint holding the lock — the account's first included,
 * whose identity is not committed yet — commits before this reads, and its
 * session is stamped with the rest; a mint that comes after waits, and is a
 * session minted after the revoke.
 *
 * With `account_deleted` or `number_released` the account's tickets also
 * leave the app for good, in the same transaction (`releaseTickets`): each is
 * marked `released_from_app` for the agents who still have it, an open or
 * pending one is resolved by the system, and the ownership rows go, so every
 * read scoped by them (`ownedTicket`) answers `404` while the tickets stay on
 * the contact. The person behind the account has changed or is gone, and a new
 * session minted later for the same `externalUserId` must not read what the
 * last one wrote. The resolved tickets' clocks stop once it commits
 * (`afterRelease`). The other reasons end sessions and leave the tickets,
 * since the same person signs in again. A create or a reply racing this takes
 * the same lock (`holdAccount`), so what it writes is either released here or
 * never written.
 */
export async function revokeSessions(
  externalUserId: string,
  reason: ApiSessionEndReason,
  now: Date,
): Promise<{ identityId: string | null; revoked: number; ticketsReleased: number }> {
  const identifier = mybluIdentifier(externalUserId);
  const outcome = await db.transaction(async (tx) => {
    await lockAccount(tx, identifier);
    const identity = await findIdentity('api', identifier, tx);
    if (!identity) return { identityId: null, revoked: 0, released: null };

    const result = await revokeStatement(tx, identity.identityId, reason, now);
    const released = releasesTickets(reason)
      ? await releaseTickets(tx, identity.identityId, reason)
      : null;
    return { identityId: identity.identityId, revoked: result.count, released };
  });
  if (outcome.released) await afterRelease(outcome.released);
  return {
    identityId: outcome.identityId,
    revoked: outcome.revoked,
    ticketsReleased: outcome.released?.count ?? 0,
  };
}

/**
 * The nightly sweep (`cleanup`): rows thirty days past their expiry. On the
 * database's clock, as the job's other retention filters are, so the statement
 * binds no instant.
 */
export async function deleteSweptApiSessions(): Promise<number> {
  const deleted = await db
    .delete(apiSessions)
    .where(
      sql`${apiSessions.expiresAt} < now() - ${sql.raw(`interval '${KEPT_AFTER_EXPIRY_DAYS} days'`)}`,
    );
  return deleted.count;
}
