import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { apiSessions, contactIdentities, contacts, type ApiSessionEndReason } from '@/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { findIdentity, pendingApiContact, resolveApiContactIn } from '@/lib/tickets/contacts';

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
      .select({ isBlocked: contacts.isBlocked, deletedAt: contacts.deletedAt })
      .from(contactIdentities)
      .innerJoin(contacts, eq(contacts.id, contactIdentities.contactId))
      .where(eq(contactIdentities.id, identityId))
      .limit(1);
    if (!contact) throw new Error('The account was purged while its session was minted');
    if (refused(contact)) return { kind: 'blocked', identityId };

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
    },
  };
}

/**
 * The statement `DELETE /session` runs: the presented token and nothing else,
 * stamped rather than deleted, so the row still says who was vouched for.
 * Exported so a test can read its parameters back (AGENTS.md, _Tests_).
 */
export function endStatement(tokenHash: string, now: Date) {
  return db
    .update(apiSessions)
    .set({ revokedAt: now, revokeReason: 'ended' satisfies ApiSessionEndReason })
    .where(and(eq(apiSessions.tokenHash, tokenHash), isNull(apiSessions.revokedAt)));
}

export async function endSession(tokenHash: string, now: Date): Promise<void> {
  await endStatement(tokenHash, now);
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
 * The plan also has `account_deleted` and `number_released` delete the
 * identity's ownership rows, so its tickets leave the app for good while they
 * stay on the contact for agents. Those rows (`api_tickets`) arrive with the
 * tickets themselves, in stage 4, and the delete with them, here; until then
 * there is nothing to delete, and the reason is recorded on the rows either way.
 */
export async function revokeSessions(
  externalUserId: string,
  reason: ApiSessionEndReason,
  now: Date,
): Promise<{ identityId: string | null; revoked: number }> {
  const identifier = mybluIdentifier(externalUserId);
  return db.transaction(async (tx) => {
    await lockAccount(tx, identifier);
    const identity = await findIdentity('api', identifier, tx);
    if (!identity) return { identityId: null, revoked: 0 };

    const result = await revokeStatement(tx, identity.identityId, reason, now);
    return { identityId: identity.identityId, revoked: result.count };
  });
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
