import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  contactIdentities,
  contactMerges,
  contactShippingAccounts,
  contacts,
  conversationEvents,
  conversations,
  messages,
  shipments,
  type MergedCounts,
} from '@/db/schema';
import { DEFAULT_CONTACT_LOCALE as DEFAULT_LOCALE } from './locale';
import { cleanQuery, textMatches, textPatterns } from '@/lib/search/text';

/**
 * Merging two contacts.
 *
 * The duplicate is the normal state of a support database, not an anomaly. One
 * person emails from work and from a personal address, messages WhatsApp from a
 * second number, or writes in before the importer ever runs — and
 * `resolveContact()` is right to create a separate contact each time, because at
 * the moment the message arrives nothing proves they are the same human. Saying
 * so is a judgement, and this is where an agent records it.
 *
 * Three rules shape everything below.
 *
 * **The loser survives as a tombstone.** `deleted_at` and
 * `merged_into_contact_id` are set; the row stays. A hard delete would take its
 * `(source_system, external_id)` with it, so the next importer run would
 * recreate the duplicate that was just merged away — and every bookmarked link
 * and quoted id would 404 rather than land on the person.
 *
 * **Nothing is copied; things move.** Identities, tickets, messages, account
 * memberships and parcel roles are re-pointed at the survivor. Copying would
 * mean two rows claiming one fact, and the pair would diverge the first time
 * anybody edited either.
 *
 * **The survivor's own facts win.** A merge fills its blanks from the loser and
 * overwrites nothing. Being told two records are one person is not being told
 * which name is the right one, and an agent who wants the other name types it —
 * on the page they are already on.
 */

/** The columns a merge reads and reconciles. */
export type MergeSide = {
  id: string;
  name: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  avatarPath: string | null;
  companyId: string | null;
  timezone: string | null;
  locale: string;
  gender: string | null;
  customFields: Record<string, unknown>;
  isBlocked: boolean;
  isShipper: boolean;
  isRecipient: boolean;
  deletedAt: Date | null;
  mergedIntoContactId: string | null;
};

export type MergeRefusal =
  'not_found' | 'same_contact' | 'already_merged' | 'target_merged' | 'target_deleted';

export type MergeResult = { ok: true; moved: MergedCounts } | { ok: false; reason: MergeRefusal };

function blank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

/**
 * Why this merge cannot happen, or null.
 *
 * Pure, and separate from the write, because every one of these is a race as
 * well as a mistake: the page was rendered, an agent thought about it, and by
 * the time they clicked one of the two contacts may have been merged by somebody
 * else. `mergeContacts()` re-runs this inside the transaction against locked
 * rows, which is the check that actually counts.
 */
export function refuseMerge(
  survivor: MergeSide | null | undefined,
  loser: MergeSide | null | undefined,
): MergeRefusal | null {
  if (!survivor || !loser) return 'not_found';
  if (survivor.id === loser.id) return 'same_contact';

  // The loser has already been folded into someone. Merging it again would move
  // rows that are no longer there and leave two tombstones disagreeing about
  // where the person went.
  if (loser.mergedIntoContactId) return 'already_merged';

  // Merging *into* a tombstone would hide live tickets behind a deleted record.
  if (survivor.mergedIntoContactId) return 'target_merged';
  if (survivor.deletedAt) return 'target_deleted';

  return null;
}

/** What a merge is allowed to change on the survivor. */
export type ContactPatch = Partial<
  Pick<
    MergeSide,
    | 'name'
    | 'primaryEmail'
    | 'primaryPhone'
    | 'avatarPath'
    | 'timezone'
    | 'companyId'
    | 'locale'
    | 'gender'
    | 'customFields'
    | 'isShipper'
    | 'isRecipient'
  >
>;

/**
 * The fields the survivor takes from the loser: blanks filled, nothing
 * overwritten.
 *
 * Returns only what changes, so an unremarkable merge produces an empty object
 * and the caller can skip the update entirely.
 */
export function reconcileContact(survivor: MergeSide, loser: MergeSide): ContactPatch {
  const patch: ContactPatch = {};

  if (blank(survivor.name) && !blank(loser.name)) patch.name = loser.name;
  if (blank(survivor.primaryEmail) && !blank(loser.primaryEmail)) {
    patch.primaryEmail = loser.primaryEmail;
  }
  if (blank(survivor.primaryPhone) && !blank(loser.primaryPhone)) {
    patch.primaryPhone = loser.primaryPhone;
  }
  // The duplicate is often the channel that had a picture — a Messenger record
  // folded into the email one the agent has been using — so a merge that
  // dropped it would lose the only face on the person.
  if (blank(survivor.avatarPath) && !blank(loser.avatarPath)) {
    patch.avatarPath = loser.avatarPath;
  }
  if (blank(survivor.timezone) && !blank(loser.timezone)) patch.timezone = loser.timezone;
  if (blank(survivor.gender) && !blank(loser.gender)) patch.gender = loser.gender;
  if (!survivor.companyId && loser.companyId) patch.companyId = loser.companyId;

  // Only ever replaces the default — see DEFAULT_LOCALE.
  if (survivor.locale === DEFAULT_LOCALE && loser.locale !== DEFAULT_LOCALE) {
    patch.locale = loser.locale;
  }

  // The survivor's keys win; the loser's fill the gaps. A custom field is the
  // one place an agent has written something nobody else records, so losing the
  // loser's copy of a field the survivor never had would lose the only copy.
  const merged = { ...loser.customFields, ...survivor.customFields };
  if (Object.keys(loser.customFields).some((key) => !(key in survivor.customFields))) {
    patch.customFields = merged;
  }

  // The role flags are a cache of "holds an account" and "is named on a parcel",
  // and every row behind both has just moved to the survivor — so the union is
  // not a guess, it is the answer. No refreshContactRoles() call needed.
  if (loser.isShipper && !survivor.isShipper) patch.isShipper = true;
  if (loser.isRecipient && !survivor.isRecipient) patch.isRecipient = true;

  // `isBlocked` is deliberately absent. It is not a fact about the person, it is
  // a decision about a record: an agent who blocked an obvious duplicate must
  // not silently block the real customer by merging it away, and a survivor who
  // is blocked stays blocked. Whoever merges can block, on this page, in a click.

  return patch;
}

const MERGE_COLUMNS = {
  id: contacts.id,
  name: contacts.name,
  primaryEmail: contacts.primaryEmail,
  primaryPhone: contacts.primaryPhone,
  avatarPath: contacts.avatarPath,
  companyId: contacts.companyId,
  timezone: contacts.timezone,
  locale: contacts.locale,
  gender: contacts.gender,
  customFields: contacts.customFields,
  isBlocked: contacts.isBlocked,
  isShipper: contacts.isShipper,
  isRecipient: contacts.isRecipient,
  deletedAt: contacts.deletedAt,
  mergedIntoContactId: contacts.mergedIntoContactId,
};

/**
 * Folds `loserId` into `survivorId`.
 *
 * One transaction, and the two contact rows are locked in a fixed order — by id,
 * not by role — so two agents merging the same pair in opposite directions block
 * each other instead of deadlocking.
 */
export async function mergeContacts(input: {
  survivorId: string;
  loserId: string;
  agentId: string | null;
}): Promise<MergeResult> {
  const { survivorId, loserId } = input;
  if (survivorId === loserId) return { ok: false, reason: 'same_contact' };

  return db.transaction(async (tx) => {
    // Deterministic lock order, then sort the rows back into roles.
    const [first, second] = [survivorId, loserId].sort();
    const locked = await tx
      .select(MERGE_COLUMNS)
      .from(contacts)
      .where(or(eq(contacts.id, first!), eq(contacts.id, second!)))
      .orderBy(contacts.id)
      .for('update');

    const survivor = locked.find((row) => row.id === survivorId);
    const loser = locked.find((row) => row.id === loserId);

    const refusal = refuseMerge(survivor, loser);
    if (refusal) return { ok: false, reason: refusal };

    // `refuseMerge` proves both are present; TypeScript needs it said again.
    if (!survivor || !loser) return { ok: false, reason: 'not_found' };

    const identities = await tx
      .update(contactIdentities)
      .set({ contactId: survivorId })
      .where(eq(contactIdentities.contactId, loserId))
      .returning({ id: contactIdentities.id });

    // Re-pointed with `returning` rather than counted first, so the timeline
    // entries below are written for exactly the tickets that moved. Updating
    // `conversations` also fires the notify trigger, so an agent with one of
    // these open sees the new requester without reloading.
    const moved = await tx
      .update(conversations)
      .set({ requesterContactId: survivorId })
      .where(eq(conversations.requesterContactId, loserId))
      .returning({ id: conversations.id });

    if (moved.length > 0) {
      // On the ticket, because that is where an agent reads history and where
      // "why is this person's name different from yesterday?" gets asked. The
      // contact-level audit row is written below as well; they answer different
      // questions.
      await tx.insert(conversationEvents).values(
        moved.map((row) => ({
          conversationId: row.id,
          type: 'requester_merged',
          actorAgentId: input.agentId,
          data: { fromContactId: loserId, intoContactId: survivorId },
        })),
      );
    }

    const authored = await tx
      .update(messages)
      .set({ authorContactId: survivorId })
      .where(eq(messages.authorContactId, loserId))
      .returning({ id: messages.id });

    // Account memberships are a composite primary key, so both contacts holding
    // the same account is an ordinary collision rather than an error — it is in
    // fact evidence they are the same person. The survivor's row stands and the
    // loser's is dropped; `link_source` on the surviving row is not upgraded,
    // because a manual assertion by an agent is not worth less than a platform
    // one that says the same thing.
    //
    // Read then insert, rather than one insert-from-select: a person holds a
    // handful of accounts, and the row count is what the audit entry needs.
    const held = await tx
      .select({
        shippingAccountId: contactShippingAccounts.shippingAccountId,
        linkSource: contactShippingAccounts.linkSource,
        linkedByAgentId: contactShippingAccounts.linkedByAgentId,
      })
      .from(contactShippingAccounts)
      .where(eq(contactShippingAccounts.contactId, loserId));

    let accountsMoved = 0;
    if (held.length > 0) {
      const inserted = await tx
        .insert(contactShippingAccounts)
        .values(held.map((row) => ({ ...row, contactId: survivorId })))
        .onConflictDoNothing({
          target: [contactShippingAccounts.contactId, contactShippingAccounts.shippingAccountId],
        })
        .returning({ shippingAccountId: contactShippingAccounts.shippingAccountId });

      accountsMoved = inserted.length;
      await tx
        .delete(contactShippingAccounts)
        .where(eq(contactShippingAccounts.contactId, loserId));
    }

    const asShipper = await tx
      .update(shipments)
      .set({ shipperContactId: survivorId })
      .where(eq(shipments.shipperContactId, loserId))
      .returning({ id: shipments.id });

    const asRecipient = await tx
      .update(shipments)
      .set({ recipientContactId: survivorId })
      .where(eq(shipments.recipientContactId, loserId))
      .returning({ id: shipments.id });

    // A parcel naming the loser at both ends is one shipment, not two.
    const parcels = new Set([...asShipper, ...asRecipient].map((row) => row.id));

    // Anything already pointing at the loser now points past it. Keeps every
    // tombstone chain exactly one hop long, so following one is a lookup rather
    // than a loop.
    await tx
      .update(contacts)
      .set({ mergedIntoContactId: survivorId })
      .where(eq(contacts.mergedIntoContactId, loserId));

    const patch = reconcileContact(survivor, loser);
    if (Object.keys(patch).length > 0) {
      await tx.update(contacts).set(patch).where(eq(contacts.id, survivorId));
    }

    await tx
      .update(contacts)
      .set({ mergedIntoContactId: survivorId, deletedAt: new Date() })
      .where(eq(contacts.id, loserId));

    const counts: MergedCounts = {
      identities: identities.length,
      conversations: moved.length,
      messages: authored.length,
      shippingAccounts: accountsMoved,
      shipments: parcels.size,
    };

    await tx.insert(contactMerges).values({
      survivorContactId: survivorId,
      mergedContactId: loserId,
      mergedByAgentId: input.agentId,
      moved: counts,
    });

    return { ok: true, moved: counts };
  });
}

/**
 * Follows the tombstone chain to the contact that is actually there.
 *
 * Merges keep chains one hop long, so this normally resolves in a single step.
 * The loop is a guard against a cycle that should not exist — a corrupt pointer
 * must not become an infinite redirect — and it returns the last live id it saw
 * rather than throwing.
 */
export async function resolveMergedContact(contactId: string): Promise<string> {
  let current = contactId;

  for (let hop = 0; hop < 8; hop += 1) {
    const rows = await db
      .select({ mergedIntoContactId: contacts.mergedIntoContactId })
      .from(contacts)
      .where(eq(contacts.id, current))
      .limit(1);

    const next = rows[0]?.mergedIntoContactId;
    if (!next || next === current) return current;
    current = next;
  }

  return current;
}

export type MergeCandidate = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  conversations: number;
  identities: number;
  /** Why it is being suggested. Absent for a candidate somebody searched for. */
  reason?: 'email' | 'phone' | 'name';
};

const CANDIDATE_COLUMNS = {
  id: contacts.id,
  name: contacts.name,
  email: contacts.primaryEmail,
  phone: contacts.primaryPhone,
  conversations: sql<number>`(
    select count(*)::int from ${conversations}
    where ${conversations.requesterContactId} = ${contacts}.id
  )`,
  identities: sql<number>`(
    select count(*)::int from ${contactIdentities}
    where ${contactIdentities.contactId} = ${contacts}.id
  )`,
};

/**
 * Contacts that are only mergeable at all: alive, not already a tombstone, and
 * not the contact being merged into.
 *
 * A tombstone is excluded because merging one twice moves nothing, and a deleted
 * contact because its tickets are already hidden — folding them in would
 * resurrect them silently.
 */
function mergeable(contactId: string) {
  return [
    ne(contacts.id, contactId),
    isNull(contacts.deletedAt),
    isNull(contacts.mergedIntoContactId),
  ];
}

/**
 * Duplicates worth looking at, without anybody typing a search.
 *
 * Matches on the three things that actually repeat when one person becomes two
 * records: the same address, the same number, the same name. Nothing here merges
 * anything — a shared address is a strong hint and a shared name is a weak one,
 * and an Egyptian support desk sees the same common name several times a week.
 * The decision stays with the agent, which is why the reason is returned and
 * shown.
 */
export async function mergeCandidates(contactId: string, limit = 8): Promise<MergeCandidate[]> {
  const self = await db
    .select({
      email: contacts.primaryEmail,
      phone: contacts.primaryPhone,
      name: contacts.name,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const me = self[0];
  if (!me) return [];

  // Built from the values rather than as correlated subqueries, so a contact
  // with no email contributes no clause at all instead of a comparison against
  // null that silently matches nothing.
  const clauses = [
    me.email ? eq(contacts.primaryEmail, me.email) : null,
    me.phone ? eq(contacts.primaryPhone, me.phone) : null,
    me.name?.trim() ? sql`lower(${contacts.name}) = lower(${me.name})` : null,
  ].filter((clause) => clause !== null);

  if (clauses.length === 0) return [];

  const rows = await db
    .select({ ...CANDIDATE_COLUMNS })
    .from(contacts)
    .where(and(...mergeable(contactId), or(...clauses)))
    .orderBy(contacts.createdAt)
    .limit(limit);

  // Only the strongest reason is worth showing, and which one that is is a
  // display decision — so it is ranked here rather than selected as three
  // booleans nobody would read.
  return rows.map((row) => ({
    ...row,
    reason:
      me.email && row.email === me.email
        ? ('email' as const)
        : me.phone && row.phone === me.phone
          ? ('phone' as const)
          : ('name' as const),
  }));
}

/** The same list, from an agent's own search rather than from a heuristic. */
export async function searchMergeCandidates(
  contactId: string,
  query: string,
  limit = 10,
): Promise<MergeCandidate[]> {
  const q = cleanQuery(query);
  if (!q) return [];

  const text = textPatterns(q);

  return db
    .select({ ...CANDIDATE_COLUMNS })
    .from(contacts)
    .where(
      and(
        ...mergeable(contactId),
        or(
          // The name the same way every other search reads one, so a duplicate
          // spelled أحمد is offered to an agent who typed احمد.
          textMatches(contacts.name, text),
          sql`${contacts.primaryEmail} ilike ${text.pattern}`,
          sql`${contacts.primaryPhone} ilike ${text.pattern}`,
        ),
      ),
    )
    .orderBy(contacts.name)
    .limit(limit);
}

export type MergeRecord = {
  id: string;
  mergedContactId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  agentName: string | null;
  moved: MergedCounts;
  createdAt: Date;
};

/**
 * What has been merged into this contact.
 *
 * Shown on the contact page, because a history that says "these three records
 * were one person, folded in by Ali in June" is the difference between a
 * surprising ticket list and an explained one.
 */
export async function mergeHistory(contactId: string): Promise<MergeRecord[]> {
  const rows = await db
    .select({
      id: contactMerges.id,
      mergedContactId: contactMerges.mergedContactId,
      name: contacts.name,
      email: contacts.primaryEmail,
      phone: contacts.primaryPhone,
      agentName: agents.name,
      moved: contactMerges.moved,
      createdAt: contactMerges.createdAt,
    })
    .from(contactMerges)
    .leftJoin(contacts, eq(contacts.id, contactMerges.mergedContactId))
    .leftJoin(agents, eq(agents.id, contactMerges.mergedByAgentId))
    .where(eq(contactMerges.survivorContactId, contactId))
    .orderBy(contactMerges.createdAt);

  return rows;
}
