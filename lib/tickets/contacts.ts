import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { companies, contactIdentities, contacts } from '@/db/schema';
import { normaliseEmail, normaliseIdentifier } from '@/lib/auth/normalise';

/**
 * Resolving an inbound message to a customer.
 *
 * `contact_identities` is the join that makes the unified inbox real: the same
 * person emailing from ali@x.com and messaging from +20100… resolves to one
 * contact, so an agent sees a single history instead of two strangers.
 */

export type ResolveInput = {
  channel: 'email' | 'whatsapp' | 'webchat' | 'facebook' | 'instagram' | 'portal' | 'api';
  identifier: string;
  displayName?: string | null;
};

export type ResolvedContact = {
  contactId: string;
  created: boolean;
};

/**
 * The contact behind an identity, without creating one.
 *
 * `resolveContact` writes a contact when it finds none, which is right for a
 * message — somebody wrote to us and there has to be a customer to file it
 * under. It is wrong for an event that can only ever attach to a thread that
 * already exists: a button press from a stranger would leave a contact row with
 * no ticket, no message and nothing to answer, one per press.
 */
export async function findContactByIdentity(
  channel: ResolveInput['channel'],
  identifier: string,
): Promise<string | null> {
  return (await findIdentity(channel, identifier))?.contactId ?? null;
}

/**
 * The identity row itself and the contact it hangs off, for a caller that keeps
 * the identity's id — a myBlu session is keyed on the identity, not on the
 * contact, which a merge changes (`pendingApiContact`, and a revoke naming an
 * account in `lib/api/sessions.ts`). The one lookup: `findContactByIdentity`
 * answers its contact half.
 *
 * On the pool unless handed a transaction. A revoke reads the identity inside
 * its own, behind the account's lock, so a first mint that held the lock
 * first is visible to it once that mint commits; read on the pool from inside
 * the transaction instead, it would be §6.91's self-deadlock.
 */
export async function findIdentity(
  channel: ResolveInput['channel'],
  identifier: string,
  executor: typeof db | Tx = db,
): Promise<{ identityId: string; contactId: string } | null> {
  const normalised = normaliseIdentifier(channel, identifier);
  if (!normalised) return null;

  const rows = await executor
    .select({ identityId: contactIdentities.id, contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(
      and(eq(contactIdentities.channel, channel), eq(contactIdentities.identifier, normalised)),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function resolveContact(input: ResolveInput): Promise<ResolvedContact> {
  const pending = await pendingContact(input);
  if ('contactId' in pending) return { contactId: pending.contactId, created: false };
  return db.transaction((tx) => resolveContactIn(tx, pending));
}

/**
 * A contact that exists, or the one that will be written for an identity
 * nobody owns yet.
 *
 * `resolveContact` in two halves, for a caller whose contact must exist only
 * if something else it writes does: a ticket form, whose new requester would
 * otherwise outlive a ticket that failed to open (`createTicket`).
 */
export type PendingContact = { contactId: string } | { create: NewContact };

/**
 * Only `pendingContact` builds one, which the brand holds: a hand-built
 * `create` would skip `normaliseIdentifier`, and an identifier the unique index
 * does not recognise as the customer's is a second contact for them.
 */
declare const normalised: unique symbol;
type NewContact = {
  channel: ResolveInput['channel'];
  identifier: string;
  displayName: string | null;
  companyId: string | null;
  readonly [normalised]: true;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The reads half: run before the caller's transaction opens, so that only the
 * insert (`resolveContactIn`) runs inside it, on its connection. A read on the
 * pool from inside a held transaction is the self-deadlock of
 * `docs/PROJECT-STATE.md` §6.91.
 */
export async function pendingContact(input: ResolveInput): Promise<PendingContact> {
  const identifier = normaliseIdentifier(input.channel, input.identifier);
  if (!identifier) throw new Error('Cannot resolve a contact without an identifier');

  // The same lookup `findContactByIdentity` does, called rather than repeated:
  // two copies of how an identity is matched would let a future change — a case
  // fold, a soft-delete filter, a merged-contact redirect — apply to one path
  // and not the other, and an interaction would then resolve to a different
  // contact than the message that created it.
  const existingId = await findContactByIdentity(input.channel, identifier);
  if (existingId) return { contactId: existingId };

  const companyId = input.channel === 'email' ? await findCompanyByEmailDomain(identifier) : null;

  return {
    create: {
      channel: input.channel,
      identifier,
      displayName: input.displayName ?? null,
      companyId,
    } as NewContact,
  };
}

/**
 * The pending contact's id, inserting it in the caller's transaction when it
 * does not exist yet.
 *
 * Nothing here reads the pool, only `tx`, and `tx` is a transaction by type:
 * handed the pool, the three writes below would each commit alone, and a
 * failure between them is the orphan contact this exists to prevent. Called
 * first in a transaction that goes on to take other locks, it waits on a racing
 * writer's identity holding none of them — only the contact it has just
 * inserted, and a key-share lock on that contact's company.
 */
export async function resolveContactIn(tx: Tx, pending: PendingContact): Promise<ResolvedContact> {
  if ('contactId' in pending) return { contactId: pending.contactId, created: false };

  const { channel, identifier, displayName, companyId } = pending.create;

  const inserted = await tx
    .insert(contacts)
    .values({
      name: displayName,
      primaryEmail: channel === 'email' ? identifier : null,
      primaryPhone: channel === 'whatsapp' ? identifier : null,
      companyId,
    })
    .returning({ id: contacts.id });

  const contactId = inserted[0]!.id;

  // Two webhooks for the same new customer can race here, and so can anything
  // that created the identity since `pendingContact` read it. The unique index
  // on (channel, identifier) is the real guard; on conflict we discard the
  // contact we just made and adopt the winner's, so one customer never ends up
  // split across two records.
  const identity = await tx
    .insert(contactIdentities)
    .values({ contactId, channel, identifier, displayName })
    .onConflictDoNothing({
      target: [contactIdentities.channel, contactIdentities.identifier],
    })
    .returning({ id: contactIdentities.id });

  if (identity.length === 0) {
    await tx.delete(contacts).where(eq(contacts.id, contactId));

    const winner = await tx
      .select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(
        and(eq(contactIdentities.channel, channel), eq(contactIdentities.identifier, identifier)),
      )
      .limit(1);

    if (!winner[0]) throw new Error('Contact identity conflict could not be resolved');
    return { contactId: winner[0].contactId, created: false };
  }

  return { contactId, created: true };
}

/**
 * Resolving a myBlu account to a customer (`plans/myblu-ticket-api.md`,
 * _Identity_): the session's identity is keyed on the account, and the phone
 * its backend vouched for decides which contact a new one hangs off.
 *
 * `resolveContact` cannot do this. It keys on one identifier, sets
 * `primary_phone` for `whatsapp` alone, and would make every myBlu user a
 * second, phoneless contact that never surfaces as a phone match beside the
 * WhatsApp contact the same person has written from. Here the identity is
 * `('api', 'myblu:<externalUserId>')` and the phone is a second input, and the
 * order is:
 *
 * 1. **The account's existing identity**, whose contact it keeps even when the
 *    phone has changed: a changed number is the same account, and if the new
 *    number's contact is the same person an agent merges them.
 * 2. **The contact owning `('whatsapp', <digits>)`**, when no other `api`
 *    identity already hangs off it and no other account's contact holds the
 *    number as its `primary_phone`. A phone the backend vouched for after an
 *    SMS code is the proof WhatsApp itself rests on, so one customer has one
 *    history for the agent. The app still reads only the tickets its own
 *    identity opened.
 * 3. **A new contact**, with `primary_phone` only when nobody holds the number.
 *    A second account on a number — the WhatsApp contact already joined, or
 *    another account's contact already holding it — is known to be a different
 *    account, and `mergeCandidates` matches a phone by equality: writing it
 *    there would raise, on the contact page, the one merge suggestion the
 *    console must not make. For a number nobody holds it is written, so a
 *    later WhatsApp contact can be suggested against it.
 *
 * The second condition in step 2 is that rule again, from the other side. An
 * account first on a number nobody held writes it as its contact's
 * `primary_phone`; a WhatsApp contact the number then writes from has it too,
 * and is rightly suggested against it. A second account joining that WhatsApp
 * contact would turn the suggestion into one between two accounts. It costs
 * the account on a recycled number — a previous holder's account still holding
 * it — the join: it gets a contact of its own, and an agent merges if the
 * WhatsApp contact is the same person.
 *
 * No `whatsapp` identity is ever written: holding a SIM today says nothing
 * about a WhatsApp account. And a contact's name is never overwritten — the
 * backend's name is used only for a contact this creates, since the stored one
 * can be an agent's correction, or a previous holder's.
 *
 * In two halves, as `pendingContact` and `resolveContactIn` are and for their
 * reason: the reads on the pool before the caller's transaction, the writes
 * inside it on `tx`, so a mint that writes no session leaves no contact
 * behind it either — and a pooled read inside a held transaction is §6.91.
 */
export type ApiContactInput = {
  /** The identity's identifier, `myblu:<externalUserId>`, exactly as stored: never trimmed here. */
  identifier: string;
  /** The phone the backend vouched for, as digits without its plus. */
  phone: string;
  /** The backend's name for the user, used only for a contact this creates. */
  name: string | null;
};

export type ApiIdentity = { identityId: string; contactId: string };

/**
 * An account with an identity already, or what the transaction decides for one
 * without: only `pendingApiContact` builds the second, which the brand holds,
 * so a hand-built one cannot skip the reads it carries.
 */
export type PendingApiContact = ApiIdentity | { create: NewApiIdentity };

declare const vouched: unique symbol;
type NewApiIdentity = {
  identifier: string;
  phone: string;
  name: string | null;
  /** Whoever owned `('whatsapp', phone)` when it was read: a candidate, decided under its lock. */
  whatsappContactId: string | null;
  readonly [vouched]: true;
};

/**
 * How a resolution ended: the existing identity, a join onto the number's
 * contact, or a new one. On `existing` the contact is the one read before the
 * transaction, which a merge committed since has moved: a caller deciding
 * anything about the contact reads it through `identityId` in its transaction,
 * as `mintSession` does.
 */
export type ApiResolution = ApiIdentity & { how: 'existing' | 'joined' | 'created' };

/** The reads half, before the caller's transaction opens. */
export async function pendingApiContact(input: ApiContactInput): Promise<PendingApiContact> {
  // `normaliseIdentifier` only trims an `api` identifier, so an identifier
  // with anything to trim is one the caller failed to refuse: `ExternalUserId`
  // allows no whitespace, and a trimmed id here would be a second account
  // stored under somebody else's key.
  if (!input.identifier || normaliseIdentifier('api', input.identifier) !== input.identifier) {
    throw new Error('An api identifier must arrive exactly as it is stored');
  }
  if (!/^[1-9]\d{7,14}$/.test(input.phone)) {
    throw new Error('A vouched-for phone arrives as E.164 digits, without its plus');
  }

  const existing = await findIdentity('api', input.identifier);
  if (existing) return existing;

  return {
    create: {
      identifier: input.identifier,
      phone: input.phone,
      name: input.name?.trim() || null,
      whatsappContactId: await findContactByIdentity('whatsapp', input.phone),
    } as NewApiIdentity,
  };
}

/**
 * The writes half, in the caller's transaction: the account's identity, on the
 * number's WhatsApp contact or on a contact of its own.
 *
 * Two mints at once for one phone under two accounts must not both find the
 * WhatsApp contact free, nor both find the number unheld, so each decision is
 * made under a lock and read in the statement after it:
 *
 * - **The join, under the contact's row lock**, taken first, and then its
 *   identities re-read in the next statement — a lock and then a read, never a
 *   join under the lock, which under READ COMMITTED re-checks only the locked
 *   row and would answer from before the wait (AGENTS.md, _A read that locks a
 *   row…_). `FOR NO KEY UPDATE`, which two mints still serialise on, and which
 *   leaves alone the KEY SHARE every message and ticket inserted for that
 *   contact takes through its foreign key: a WhatsApp message arriving
 *   meanwhile is not held up by a mint. Then, still before it joins, under the
 *   number's advisory lock: whether another account's contact holds the
 *   number. Asked before that lock, it could miss an account on the create
 *   path that read the number as free and has not committed its
 *   `primary_phone` yet.
 * - **A new contact, under the number's advisory lock**, a transaction lock as
 *   AGENTS.md asks of every advisory lock on the pooler. No row stands for a
 *   number nobody holds, so there is no row to lock: without it, two accounts
 *   minting at once on a fresh number would each find it free and both write
 *   `primary_phone`, and the merge suggestion above would follow. A join that
 *   was refused takes it again on the way here, which a transaction-level
 *   advisory lock allows.
 *
 * The row lock is only ever taken first and the number's lock only after it, so
 * two mints cannot wait on each other in opposite orders.
 *
 * The same account minting twice at once — two devices, or a retry — meets on
 * the identity's unique index: the second insert does nothing, the contact it
 * made for itself is deleted, and it adopts the first one's identity, as
 * `resolveContactIn` does.
 */
export async function resolveApiContactIn(
  tx: Tx,
  pending: PendingApiContact,
): Promise<ApiResolution> {
  if (!('create' in pending)) return { ...pending, how: 'existing' };

  const { identifier, phone, name, whatsappContactId } = pending.create;

  let contactId: string;
  let how: 'joined' | 'created';
  if (whatsappContactId && (await joinable(tx, whatsappContactId, phone))) {
    contactId = whatsappContactId;
    how = 'joined';
  } else {
    await lockNumber(tx, phone);
    const held = await numberHeld(tx, phone);
    const [created] = await tx
      .insert(contacts)
      .values({ name, primaryPhone: held ? null : phone })
      .returning({ id: contacts.id });
    contactId = created!.id;
    how = 'created';
  }

  const [identity] = await tx
    .insert(contactIdentities)
    .values({ contactId, channel: 'api', identifier, displayName: name, isVerified: true })
    .onConflictDoNothing({ target: [contactIdentities.channel, contactIdentities.identifier] })
    .returning({ id: contactIdentities.id });

  if (identity) return { identityId: identity.id, contactId, how };

  if (how === 'created') await tx.delete(contacts).where(eq(contacts.id, contactId));
  const [winner] = await tx
    .select({ identityId: contactIdentities.id, contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(and(eq(contactIdentities.channel, 'api'), eq(contactIdentities.identifier, identifier)))
    .limit(1);
  if (!winner) throw new Error('Contact identity conflict could not be resolved');
  return { ...winner, how: 'existing' };
}

/** The number's advisory lock, for the rest of the transaction. */
async function lockNumber(tx: Tx, phone: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`api-phone:${phone}`}::text, 0))`,
  );
}

/**
 * Whether the number's WhatsApp contact is free to join, decided under its row
 * lock: still a live contact, still the number's owner — a merge can have moved
 * the number since it was read — and with no `api` identity on it; and then,
 * under the number's lock, with no other account's contact holding the number.
 */
async function joinable(tx: Tx, contactId: string, phone: string): Promise<boolean> {
  const [locked] = await tx
    .select({ deletedAt: contacts.deletedAt })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .for('no key update');
  if (!locked || locked.deletedAt) return false;

  const identities = await tx
    .select({ channel: contactIdentities.channel, identifier: contactIdentities.identifier })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.contactId, contactId),
        inArray(contactIdentities.channel, ['whatsapp', 'api']),
      ),
    );

  const ownsNumber = identities.some((i) => i.channel === 'whatsapp' && i.identifier === phone);
  const joinedAlready = identities.some((i) => i.channel === 'api');
  if (!ownsNumber || joinedAlready) return false;

  await lockNumber(tx, phone);
  return !(await anotherAccountHolds(tx, phone, contactId));
}

/**
 * Whether a live contact other than `except` has the number as its
 * `primary_phone` and an `api` identity on it: an account that minted first on
 * a number nobody held. Read under the number's lock, which is the lock that
 * account wrote `primary_phone` under. A plain read, so the join is safe: the
 * rule against joins is about a read that locks.
 */
async function anotherAccountHolds(tx: Tx, phone: string, except: string): Promise<boolean> {
  const [holder] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .innerJoin(
      contactIdentities,
      and(eq(contactIdentities.contactId, contacts.id), eq(contactIdentities.channel, 'api')),
    )
    .where(
      and(eq(contacts.primaryPhone, phone), isNull(contacts.deletedAt), ne(contacts.id, except)),
    )
    .limit(1);
  return holder !== undefined;
}

/**
 * Whether somebody holds the number already: a WhatsApp identity, or a live
 * contact whose `primary_phone` it is — another account's contact made here,
 * or one an agent or an import gave the number. Read under the number's lock.
 * `primary_phone` has no btree, but its trigram index (`db/sql/001`) answers
 * equality, and this runs once per account, when its first session is minted.
 */
async function numberHeld(tx: Tx, phone: string): Promise<boolean> {
  const [whatsapp] = await tx
    .select({ id: contactIdentities.id })
    .from(contactIdentities)
    .where(and(eq(contactIdentities.channel, 'whatsapp'), eq(contactIdentities.identifier, phone)))
    .limit(1);
  if (whatsapp) return true;

  const [holder] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.primaryPhone, phone), isNull(contacts.deletedAt)))
    .limit(1);
  return holder !== undefined;
}

/**
 * Writes back what a channel's profile API told us about a customer.
 *
 * Where the two rules differ, and why:
 *
 * - `contact_identities.display_name` is *what this channel calls them* and is
 *   overwritten every time, because that is the column's whole job. A person
 *   who renames their Instagram account should read as their new handle here.
 * - `contacts.name` is filled **only when it is empty**. It is the name an
 *   agent may have typed, or one a merge carried over from another channel, and
 *   a profile refresh must never quietly replace a human's correction with
 *   whatever Meta currently returns.
 *
 * `markFetched` is what closes the identity to further lookups, and a caller
 * that only got *part* of an answer must pass false. A customer whose profile
 * came back with a picture we then failed to download is not finished — stamping
 * them would leave them permanently faceless while Meta holds a picture for
 * them, and the backfill would skip them for the same reason. It is stamped for
 * an empty-but-successful answer, though: that is the whole point of the column,
 * since a locked-down profile answers with nothing and would otherwise be
 * re-fetched forever.
 */
export async function applyChannelProfile(input: {
  contactId: string;
  channel: ResolveInput['channel'];
  identifier: string;
  name: string | null;
  avatarPath: string | null;
  /** The channel's own locale code, e.g. Messenger's `ar_AR`. Stored verbatim. */
  profileLocale?: string | null;
  /** 'male' or 'female', already normalised. */
  gender?: string | null;
  /** False when the answer was incomplete and the identity should stay open. */
  markFetched: boolean;
}): Promise<void> {
  const identifier = normaliseIdentifier(input.channel, input.identifier);
  const name = input.name?.trim() || null;
  const profileLocale = input.profileLocale?.trim() || null;
  const gender = input.gender?.trim() || null;

  const identityPatch = {
    ...(name ? { displayName: name } : {}),
    ...(profileLocale ? { profileLocale } : {}),
    ...(input.markFetched ? { profileFetchedAt: new Date() } : {}),
  };

  await db.transaction(async (tx) => {
    /*
      Skipped when there is nothing to write, because Drizzle throws
      `No values to set` on an empty patch rather than emitting a harmless
      no-op UPDATE — and it throws *inside the transaction*, so a profile that
      answered with a picture and no name would take the avatar and gender
      writes below down with it and fail the job with a message naming neither
      the contact nor the cause. Reachable whenever a locked-down profile is
      read and the avatar download fails: no name, no locale, and `markFetched`
      false.
    */
    if (Object.keys(identityPatch).length > 0) {
      await tx
        .update(contactIdentities)
        .set(identityPatch)
        .where(
          and(
            eq(contactIdentities.channel, input.channel),
            eq(contactIdentities.identifier, identifier),
          ),
        );
    }

    // Two statements rather than one patch, because the two columns have
    // different rules and folding them together makes the stricter rule win:
    // a contact who already has a name would lose the picture as well.
    if (input.avatarPath) {
      await tx
        .update(contacts)
        .set({ avatarPath: input.avatarPath })
        .where(eq(contacts.id, input.contactId));
    }

    if (name) {
      await tx
        .update(contacts)
        .set({ name })
        .where(
          and(
            eq(contacts.id, input.contactId),
            // The empty-name rule, enforced in the WHERE rather than by reading
            // first and deciding: an agent naming the contact between the read
            // and the write would otherwise lose their edit to this job.
            sql`(${contacts.name} IS NULL OR ${contacts.name} = '')`,
          ),
        );
    }

    if (gender) {
      await tx
        .update(contacts)
        .set({ gender })
        .where(and(eq(contacts.id, input.contactId), isNull(contacts.gender)));
    }
  });
}

/**
 * Whether this identity's channel profile has ever been asked for.
 *
 * Deliberately *not* folded into `resolveContact`. That function is on the hot
 * path of every inbound message on all six channels, and only the two Meta ones
 * have a profile API to ask — widening its query and its return type to carry an
 * answer the other five discard is a join that email and WhatsApp pay for
 * nothing. This is one lookup on the `(channel, identifier)` unique index, made
 * only where the question is real.
 *
 * The condition is "never asked", and only that. Gating on the name as well
 * looks safer and is not: an identity that arrived with a display name would
 * never be asked, so it would never get a picture either — and on Instagram,
 * where the handle often does arrive in the payload, that is precisely the
 * channel where a face is most useful. `profileFetchedAt` is the honest record
 * of whether the question has been put, and `applyChannelProfile` is what
 * answers it.
 */
export async function needsChannelProfile(
  channel: ResolveInput['channel'],
  identifier: string,
): Promise<boolean> {
  const rows = await db
    .select({ profileFetchedAt: contactIdentities.profileFetchedAt })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channel, channel),
        eq(contactIdentities.identifier, normaliseIdentifier(channel, identifier)),
      ),
    )
    .limit(1);

  // No row means the identity was not written — nothing to attach a profile to.
  return rows[0] !== undefined && rows[0].profileFetchedAt === null;
}

/**
 * Associates a new contact with a company by email domain, so B2B customers
 * group automatically instead of an agent doing it by hand.
 */
async function findCompanyByEmailDomain(email: string): Promise<string | null> {
  const domain = normaliseEmail(email).split('@')[1];
  if (!domain) return null;

  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(sql`${domain} = ANY(${companies.domains})`)
    .limit(1);

  return rows[0]?.id ?? null;
}
