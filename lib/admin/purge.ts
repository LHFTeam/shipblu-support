/**
 * Destroying a ticket or a customer outright.
 *
 * This is the only code in the system that takes something away rather than
 * hiding it, and it exists because the helpdesk is still being tested against
 * real traffic: a mis-routed test ticket or a contact invented while trying a
 * channel out is not something to keep forever behind a `deleted_at`, and the
 * archive is being measured, so junk in it costs something.
 *
 * Everywhere else in this schema the answer to "delete" is a tombstone —
 * `contacts.merged_into_contact_id`, `conversations.merged_into_id`,
 * `deleted_at` on both — and those remain the right answer for merges and for
 * the reversible hide `ticket.delete` is reserved for. What follows is
 * deliberately the other thing, and three properties keep it honest.
 *
 * **The database already knows the shape of the blast.** Every table that hangs
 * off a conversation is `on delete cascade`, so `delete from conversations`
 * takes messages, attachments, the timeline, watchers, presence, CSAT, the
 * shipment and account links and the side conversations with it in one
 * statement. Nothing here re-implements that. What it does instead is *read the
 * cascade before firing it*, because the two things a cascade cannot do are tell
 * an admin what is about to go and clean up what lives outside Postgres.
 *
 * **A customer takes their tickets with them.**
 * `conversations.requester_contact_id` is `on delete restrict` and `not null`, so
 * there is no version of "delete the contact, keep the tickets" that this schema
 * can hold. That is not a limitation to work around — a ticket whose requester is
 * unknowable is not worth keeping — but it does mean a contact purge is the
 * widest action in the console, and the preview below exists so nobody discovers
 * that afterwards.
 *
 * **What is not in Postgres is not cascaded.** Attachment bytes and profile
 * pictures live in a private Storage bucket that knows nothing about foreign
 * keys, and queued jobs name their subject in an opaque JSON payload. Both are
 * handled here explicitly; `webhook_events` deliberately is not — see
 * `RETAINED` in `./purge-summary`, which the confirmation panel reads out.
 */
import { and, count, eq, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  adminDeletions,
  attachments,
  contactIdentities,
  contactShippingAccounts,
  contacts,
  conversationEvents,
  conversations,
  csatSurveys,
  messages,
  shipments,
  sideConversationMessages,
  sideConversations,
} from '@/db/schema';
import { removeObjects } from '@/lib/storage';
import { purgeJobs } from './purge-jobs';
import {
  contactConfirmation,
  contactLabel,
  confirmationMatches,
  NO_COUNTS,
  RETAINED,
  type PurgeCounts,
  type PurgePreview,
  type PurgeResult,
} from './purge-summary';

export type { PurgeCounts, PurgePreview, PurgeRefusal, PurgeResult } from './purge-summary';

/**
 * Every conversation that must go with these, following merge tombstones
 * backwards.
 *
 * A ticket merged *into* one being purged is an empty shell whose content moved
 * to the survivor, and `conversations.merged_into_id` is `on delete set null` —
 * so leaving it behind would not leave a harmless orphan, it would clear the
 * pointer that hides it and float an empty ticket back into the inbox. The same
 * reasoning applies to contact tombstones below.
 *
 * Bounded like `resolveMergedContact()`: merges are supposed to keep chains one
 * hop long, and a corrupt pointer must cost a bounded number of round trips
 * rather than loop forever.
 */
async function withMergedInto(
  tx: typeof db,
  ids: string[],
): Promise<{ ids: string[]; tombstones: number }> {
  const all = new Set(ids);
  let frontier = ids;

  for (let hop = 0; hop < 8 && frontier.length > 0; hop += 1) {
    const rows = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(inArray(conversations.mergedIntoId, frontier));

    frontier = rows.map((row) => row.id).filter((id) => !all.has(id));
    for (const id of frontier) all.add(id);
  }

  return { ids: [...all], tombstones: all.size - ids.length };
}

/**
 * Reads the cascade without firing it.
 *
 * Counted with subqueries rather than by pulling ids back, so a contact with
 * eight hundred tickets costs the same round trips as one with two. The numbers
 * are what the confirmation dialog shows, and they are read again inside the
 * transaction so what gets recorded is what actually went — a preview rendered
 * a minute ago is a preview, not a receipt.
 */
async function countFor(tx: typeof db, conversationIds: string[]): Promise<PurgeCounts> {
  if (conversationIds.length === 0) return { ...NO_COUNTS };

  const messageIds = tx
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.conversationId, conversationIds));

  const sideIds = tx
    .select({ id: sideConversations.id })
    .from(sideConversations)
    .where(inArray(sideConversations.conversationId, conversationIds));

  const sideMessageIds = tx
    .select({ id: sideConversationMessages.id })
    .from(sideConversationMessages)
    .where(inArray(sideConversationMessages.sideConversationId, sideIds));

  const [messageCount, eventCount, sideCount, sideMessageCount, csatCount, attachmentCount] =
    await Promise.all([
      tx
        .select({ n: count() })
        .from(messages)
        .where(inArray(messages.conversationId, conversationIds)),
      tx
        .select({ n: count() })
        .from(conversationEvents)
        .where(inArray(conversationEvents.conversationId, conversationIds)),
      tx
        .select({ n: count() })
        .from(sideConversations)
        .where(inArray(sideConversations.conversationId, conversationIds)),
      tx
        .select({ n: count() })
        .from(sideConversationMessages)
        .where(inArray(sideConversationMessages.sideConversationId, sideIds)),
      tx
        .select({ n: count() })
        .from(csatSurveys)
        .where(inArray(csatSurveys.conversationId, conversationIds)),
      tx
        .select({ n: count() })
        .from(attachments)
        .where(
          or(
            inArray(attachments.messageId, messageIds),
            inArray(attachments.sideMessageId, sideMessageIds),
          ),
        ),
    ]);

  return {
    ...NO_COUNTS,
    conversations: conversationIds.length,
    messages: messageCount[0]?.n ?? 0,
    events: eventCount[0]?.n ?? 0,
    sideConversations: sideCount[0]?.n ?? 0,
    sideMessages: sideMessageCount[0]?.n ?? 0,
    csatSurveys: csatCount[0]?.n ?? 0,
    attachments: attachmentCount[0]?.n ?? 0,
  };
}

/**
 * The Storage keys these conversations own, read before the rows that name them
 * are deleted.
 *
 * Every attachment in the system — ticket and side conversation alike — is
 * written under `conversations/<id>/` by `buildAttachmentPath()`, so a prefix
 * delete would also work. Exact keys are used instead because the column is the
 * authority on what we actually wrote: a path convention that changes later
 * would silently orphan everything stored under the old one, and this way the
 * only thing that can go stale is a row we are deleting anyway.
 */
async function storagePathsFor(tx: typeof db, conversationIds: string[]): Promise<string[]> {
  if (conversationIds.length === 0) return [];

  const messageIds = tx
    .select({ id: messages.id })
    .from(messages)
    .where(inArray(messages.conversationId, conversationIds));

  const sideMessageIds = tx
    .select({ id: sideConversationMessages.id })
    .from(sideConversationMessages)
    .where(
      inArray(
        sideConversationMessages.sideConversationId,
        tx
          .select({ id: sideConversations.id })
          .from(sideConversations)
          .where(inArray(sideConversations.conversationId, conversationIds)),
      ),
    );

  const rows = await tx
    .select({ path: attachments.storagePath })
    .from(attachments)
    .where(
      or(
        inArray(attachments.messageId, messageIds),
        inArray(attachments.sideMessageId, sideMessageIds),
      ),
    );

  return rows.map((row) => row.path);
}

/**
 * Writes the one row a purge leaves behind.
 *
 * Called **inside** the transaction, so the record and the deletion commit
 * together or not at all. The obvious alternative — write it afterwards, once
 * the Storage cleanup has reported how many objects it could not remove — loses
 * the audit row entirely if that write fails, which is the one outcome this
 * table exists to prevent.
 *
 * The Storage keys go in with it, as `pendingObjects`, for the same reason. The
 * rows that named them are deleted by this transaction, so from the moment it
 * commits this row is the only place left that knows them. Held only in memory
 * until `removeObjects()` returns, a worker killed in between — a deploy, an
 * out-of-memory, a request timeout — would orphan every one of them with no way
 * to find them again. `settlePendingObjects()` shrinks the list afterwards.
 */
async function recordDeletion(
  tx: typeof db,
  input: {
    subject: 'conversation' | 'contact';
    subjectId: string;
    summary: string;
    counts: PurgeCounts;
    ticketNumbers: number[];
    pendingObjects: string[];
    agent: { id: string; name: string } | null;
  },
): Promise<string | null> {
  const rows = await tx
    .insert(adminDeletions)
    .values({
      subject: input.subject,
      subjectId: input.subjectId,
      summary: input.summary,
      details: {
        counts: input.counts,
        ticketNumbers: input.ticketNumbers,
        retained: [...RETAINED],
        ...(input.pendingObjects.length > 0 ? { pendingObjects: input.pendingObjects } : {}),
      },
      deletedByAgentId: input.agent?.id ?? null,
      deletedByLabel: input.agent?.name ?? null,
    })
    .returning({ id: adminDeletions.id });

  return rows[0]?.id ?? null;
}

/**
 * Shrinks `pendingObjects` to the keys Storage would not remove, or drops it
 * when every one went.
 *
 * The one writer of that key after `recordDeletion()`, so the key always means
 * one thing: objects that may still be in the bucket although nothing names
 * them. While the cleanup runs that is all of them; if this write never lands —
 * the process died, or this update failed — it stays all of them, which is an
 * over-count rather than a loss, and re-deleting a key Storage no longer holds
 * succeeds, so whoever chases the list can simply delete it all again.
 *
 * Best-effort by design: the deletion is already committed and correct, and
 * this must never turn a successful purge into a failed one.
 */
async function settlePendingObjects(
  deletionId: string | null,
  pending: string[],
  failed: string[],
): Promise<void> {
  if (!deletionId || pending.length === 0) return;

  try {
    await db
      .update(adminDeletions)
      .set({
        details:
          failed.length === 0
            ? sql`${adminDeletions.details} - 'pendingObjects'`
            : sql`${adminDeletions.details} || ${JSON.stringify({ pendingObjects: failed })}::jsonb`,
      })
      .where(eq(adminDeletions.id, deletionId));
  } catch {
    // Nothing useful to do: the purge happened, and the list left on the row
    // still covers every key that could remain.
  }
}

/**
 * The ticket numbers of every conversation a purge takes, in order.
 *
 * Read from the final scope rather than from whatever the caller started with:
 * `withMergedInto` adds the tombstone tickets merged into the target — raised by
 * somebody else, for a contact purge — and a panel that lists fewer numbers than
 * the count beside it says is a panel nobody trusts twice. A ticket purge is not
 * exempt: "1 ticket" beside a count of three conversations, with no word of
 * which, is exactly the surprise the preview exists to prevent.
 */
async function ticketNumbersFor(tx: typeof db, conversationIds: string[]): Promise<number[]> {
  if (conversationIds.length === 0) return [];

  const rows = await tx
    .select({ number: conversations.number })
    .from(conversations)
    .where(inArray(conversations.id, conversationIds));

  return rows.map((row) => row.number).sort((a, b) => a - b);
}

/** How a ticket is named once its row is gone. */
function conversationSummary(row: {
  number: number;
  channel: string;
  subject: string | null;
}): string {
  const subject = row.subject?.trim();
  return `Ticket #${row.number} (${row.channel})${subject ? ` — ${subject}` : ''}`;
}

/** What a conversation purge would destroy, or null if there is no such ticket. */
export async function previewConversationPurge(
  conversationId: string,
): Promise<PurgePreview | null> {
  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      channel: conversations.channel,
      subject: conversations.subject,
    })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const conversation = rows[0];
  if (!conversation) return null;

  const { ids, tombstones } = await withMergedInto(db, [conversation.id]);
  const [counts, ticketNumbers] = await Promise.all([countFor(db, ids), ticketNumbersFor(db, ids)]);

  return {
    id: conversation.id,
    summary: conversationSummary(conversation),
    confirmation: String(conversation.number),
    counts: { ...counts, tombstones },
    ticketNumbers,
  };
}

/** What a contact purge would destroy, or null if there is no such contact. */
export async function previewContactPurge(contactId: string): Promise<PurgePreview | null> {
  const rows = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      primaryEmail: contacts.primaryEmail,
      primaryPhone: contacts.primaryPhone,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);

  const contact = rows[0];
  if (!contact) return null;

  const { numbers, counts } = await contactScope(db, contact.id);

  return {
    id: contact.id,
    summary: contactLabel(contact),
    confirmation: contactConfirmation(contact),
    counts,
    ticketNumbers: numbers,
  };
}

/**
 * Everything a contact purge reaches: its own tickets, the contact tombstones
 * that were merged into it, and those tombstones' tickets.
 *
 * The tombstones go for the reason the merge code gives for creating them — a
 * merged-away contact exists only to redirect to the survivor. Once the survivor
 * is gone the redirect points nowhere, `contacts.merged_into_contact_id` is
 * `set null`, and what is left is a deleted contact with no explanation and no
 * way back to one, still holding the `(source_system, external_id)` that made it
 * a tombstone rather than a hard delete in the first place.
 */
async function contactScope(
  tx: typeof db,
  contactId: string,
): Promise<{ ids: string[]; contactIds: string[]; numbers: number[]; counts: PurgeCounts }> {
  const merged = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.mergedIntoContactId, contactId));

  const contactIds = [contactId, ...merged.map((row) => row.id)];

  const owned = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(inArray(conversations.requesterContactId, contactIds));

  const { ids, tombstones } = await withMergedInto(
    tx,
    owned.map((row) => row.id),
  );

  const [numbers, counts, identityCount, accountCount, shipmentCount] = await Promise.all([
    ticketNumbersFor(tx, ids),
    countFor(tx, ids),
    tx
      .select({ n: count() })
      .from(contactIdentities)
      .where(inArray(contactIdentities.contactId, contactIds)),
    tx
      .select({ n: count() })
      .from(contactShippingAccounts)
      .where(inArray(contactShippingAccounts.contactId, contactIds)),
    tx
      .select({ n: count() })
      .from(shipments)
      .where(
        or(
          inArray(shipments.shipperContactId, contactIds),
          inArray(shipments.recipientContactId, contactIds),
        ),
      ),
  ]);

  return {
    ids,
    contactIds,
    numbers,
    counts: {
      ...counts,
      tombstones: merged.length + tombstones,
      identities: identityCount[0]?.n ?? 0,
      shippingAccountLinks: accountCount[0]?.n ?? 0,
      shipmentsDetached: shipmentCount[0]?.n ?? 0,
    },
  };
}

/**
 * Destroys one ticket.
 *
 * The row is locked and re-read inside the transaction, and the confirmation is
 * checked against what that read says rather than against anything the form
 * carried — the same rule every action in this codebase follows, and it matters
 * more here than anywhere else.
 *
 * Storage is cleaned up **after** the commit, and deliberately cannot fail the
 * purge: an HTTP delete has no place inside a transaction that holds locks on
 * `conversations`, and there is nothing sensible to roll back to once the rows
 * are gone. The keys are written into the audit row before the commit and
 * trimmed to the ones that could not be removed after it, so that row — the only
 * place they can still be chased from — holds them however the cleanup ends.
 */
export async function purgeConversation(input: {
  conversationId: string;
  confirmation: string;
  agent: { id: string; name: string } | null;
}): Promise<PurgeResult> {
  const outcome = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: conversations.id,
        number: conversations.number,
        channel: conversations.channel,
        subject: conversations.subject,
      })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .limit(1)
      .for('update');

    const conversation = rows[0];
    if (!conversation) return { ok: false as const, reason: 'not_found' as const };

    if (!confirmationMatches(String(conversation.number), input.confirmation)) {
      return { ok: false as const, reason: 'confirmation_mismatch' as const };
    }

    const { ids, tombstones } = await withMergedInto(tx, [conversation.id]);
    const counts = { ...(await countFor(tx, ids)), tombstones };
    const ticketNumbers = await ticketNumbersFor(tx, ids);
    const paths = [...new Set(await storagePathsFor(tx, ids))];
    const summary = conversationSummary(conversation);

    const deletionId = await recordDeletion(tx, {
      subject: 'conversation',
      subjectId: conversation.id,
      summary,
      counts,
      ticketNumbers,
      pendingObjects: paths,
      agent: input.agent,
    });

    await purgeJobs(tx, ids);
    await tx.delete(conversations).where(inArray(conversations.id, ids));

    return { ok: true as const, summary, counts, paths, deletionId };
  });

  if (!outcome.ok) return outcome;

  const { failed } = await removeObjects(outcome.paths);
  await settlePendingObjects(outcome.deletionId, outcome.paths, failed);

  return {
    ok: true,
    summary: outcome.summary,
    counts: outcome.counts,
    orphanedObjects: failed.length,
  };
}

/**
 * Destroys one customer, and every ticket they ever raised.
 *
 * The tickets go first and by necessity: `requester_contact_id` is
 * `on delete restrict`, so the contact row cannot be removed while one survives.
 * Everything else about the contact is `on delete cascade` — identities, portal
 * sessions and tokens, verification links, account memberships, and the merge
 * records — and shipments are `set null`, which is the right answer for a parcel:
 * it is a fact about a box that happened, not about our record of a person.
 */
export async function purgeContact(input: {
  contactId: string;
  confirmation: string;
  agent: { id: string; name: string } | null;
}): Promise<PurgeResult> {
  const outcome = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: contacts.id,
        name: contacts.name,
        primaryEmail: contacts.primaryEmail,
        primaryPhone: contacts.primaryPhone,
      })
      .from(contacts)
      .where(eq(contacts.id, input.contactId))
      .limit(1)
      .for('update');

    const contact = rows[0];
    if (!contact) return { ok: false as const, reason: 'not_found' as const };

    if (!confirmationMatches(contactConfirmation(contact), input.confirmation)) {
      return { ok: false as const, reason: 'confirmation_mismatch' as const };
    }

    const { ids, contactIds, numbers, counts } = await contactScope(tx, contact.id);
    const paths = await storagePathsFor(tx, ids);

    // Profile pictures for the contact and for every tombstone folded into it —
    // tombstones very much included, which is why this is not filtered on
    // `deleted_at`. `buildAvatarPath()` is not used to derive the keys: the
    // column is what was actually written, and a merge copies a loser's
    // `avatar_path` onto the survivor, so two rows can legitimately name one
    // object; the set below keeps the audit row's list to one entry per key.
    const avatars = await tx
      .select({ path: contacts.avatarPath })
      .from(contacts)
      .where(and(inArray(contacts.id, contactIds), isNotNull(contacts.avatarPath)));
    const avatarPaths = [
      ...new Set(avatars.map((row) => row.path).filter((path) => path !== null)),
    ];

    // That sharing cuts the other way too. Purging a merged-away contact on its
    // own reaches the loser but not the survivor, and the survivor is showing
    // the picture it inherited — the very object the loser's column names.
    // Deleting it would leave a live contact pointing at a key that 404s, with
    // nothing to say why. So a key any contact outside this purge still names is
    // not ours to remove; it goes when the last contact holding it does.
    const stillNamed =
      avatarPaths.length === 0
        ? []
        : await tx
            .select({ path: contacts.avatarPath })
            .from(contacts)
            .where(
              and(inArray(contacts.avatarPath, avatarPaths), notInArray(contacts.id, contactIds)),
            );
    const shared = new Set(stillNamed.map((row) => row.path));

    const summary = contactLabel(contact);
    const objects = [...new Set([...paths, ...avatarPaths.filter((path) => !shared.has(path))])];

    const deletionId = await recordDeletion(tx, {
      subject: 'contact',
      subjectId: contact.id,
      summary,
      counts,
      ticketNumbers: numbers,
      pendingObjects: objects,
      agent: input.agent,
    });

    await purgeJobs(tx, ids, contactIds);
    if (ids.length > 0) await tx.delete(conversations).where(inArray(conversations.id, ids));
    await tx.delete(contacts).where(inArray(contacts.id, contactIds));

    return {
      ok: true as const,
      summary,
      counts,
      paths: objects,
      deletionId,
    };
  });

  if (!outcome.ok) return outcome;

  const { failed } = await removeObjects(outcome.paths);
  await settlePendingObjects(outcome.deletionId, outcome.paths, failed);

  return {
    ok: true,
    summary: outcome.summary,
    counts: outcome.counts,
    orphanedObjects: failed.length,
  };
}
