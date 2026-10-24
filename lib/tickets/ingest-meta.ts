import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, conversationEvents, conversations, messages, ticketStatuses } from '@/db/schema';
import type {
  MetaPlatform,
  NormalisedComment,
  NormalisedDirectMessage,
  NormalisedInteraction,
  NormalisedReceipt,
} from '@/lib/meta/types';
import { enqueue, type EnqueueOptions } from '@/lib/queue';
import {
  commentChannelOf,
  isCommentChannel,
  metaPlatformOf,
  type MetaChannel,
} from './channel-policy';
import { onCustomerReply } from '@/lib/sla';
import { findContactByIdentity, needsChannelProfile, resolveContact } from './contacts';
import { UNNAMED_SUBJECT } from './customer-text';
import { latest } from './latest';
import { afterInboundMessage, afterMessageStored } from './lifecycle';
import { findLiveConversation } from './live-conversation';
import { reopenResolved } from './reopen';
import { requireDefaultOpenStatusId } from './statuses';

/**
 * Inbound Facebook and Instagram → conversations.
 *
 * Two threading rules, because the two kinds of event are not the same thing:
 *
 * - A **direct message** threads on the customer, as WhatsApp does on each of
 *   our numbers. One live conversation per person per platform, so the console
 *   reads as a chat rather than as a ticket per message.
 *
 * - A **comment** threads on the comment it belongs to. One ticket per
 *   top-level comment and its replies, keyed on the root comment id, so a
 *   customer who comments on two posts gets two tickets — which is right,
 *   because they are two conversations about two things, in public, and each
 *   needs its own public answer.
 */

export type MetaIngestResult = {
  conversationId: string;
  conversationNumber: number;
  messageId: string;
  createdConversation: boolean;
  duplicate: boolean;
};

// --- Direct messages --------------------------------------------------------

export async function ingestMetaMessage(
  message: NormalisedDirectMessage,
): Promise<MetaIngestResult> {
  const existingMessage = await findByChannelMessageId(message.mid);
  if (existingMessage) return existingMessage;

  const { contactId } = await resolveContact({
    channel: message.platform,
    identifier: message.from,
    displayName: message.senderName,
  });

  // Messenger and Instagram identify the sender by a scoped id and nothing else,
  // so unless the profile is looked up this ticket is filed under a 17-digit
  // number. Queued before the ticket is written rather than after, because the
  // name is wanted on the first render.
  if (await needsChannelProfile(message.platform, message.from)) {
    await queueProfileLookup(message.platform, contactId, message.from);
  }

  const channel = await channelFor(message.platform);
  const existing = await findLiveConversation(contactId, { channel: message.platform });

  const result = await db.transaction(async (tx) => {
    let conversationId: string;
    let conversationNumber: number;
    let createdConversation = false;

    if (existing) {
      conversationId = existing.id;
      conversationNumber = existing.number;

      if (existing.statusCategory === 'resolved') {
        await reopenResolved(
          tx,
          { id: conversationId, reopenCount: existing.reopenCount },
          { actorLabel: `inbound_${message.platform}`, reason: 'customer_replied' },
        );
      }
    } else {
      const statusId = await requireDefaultOpenStatusId(tx);

      const inserted = await tx
        .insert(conversations)
        .values({
          channel: message.platform,
          channelId: channel?.id ?? null,
          statusId,
          // Neither platform has a subject. The first message is what makes the
          // ticket list scannable instead of a column of "Instagram".
          subject: subjectFrom(message.text, UNNAMED_SUBJECT[message.platform]),
          requesterContactId: contactId,
          groupId: channel?.defaultGroupId ?? null,
          lastMessageAt: message.sentAt,
          lastCustomerMessageAt: message.sentAt,
        })
        .returning({ id: conversations.id, number: conversations.number });

      conversationId = inserted[0]!.id;
      conversationNumber = inserted[0]!.number;
      createdConversation = true;
    }

    const insertedMessage = await tx
      .insert(messages)
      .values({
        conversationId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contactId,
        bodyText: message.text,
        bodyHtml: null,
        rawBody: JSON.stringify(message.raw),
        channelMessageId: message.mid,
        inReplyTo: message.replyToMid,
        fromAddress: message.from,
        deliveryStatus: 'delivered',
        deliveredAt: message.sentAt,
        meta: {
          metaKind: 'direct_message',
          platform: message.platform,
          accountId: message.accountId,
          // Which of the two Meta connections delivered this. Recorded beside
          // `standby` rather than instead of it, because it is what makes the
          // flag readable: handover belongs to the Facebook Page, so a standby
          // reported by the Page connection says nothing about a reply sent
          // with the Instagram account's own token.
          connection: message.connection,
          // Whether this app may answer the thread at all, recorded per message
          // because thread control moves: the same customer can be answerable
          // today and handed to another inbox tool tomorrow.
          standby: message.standby,
          attachments: message.attachments,
        },
        createdAt: message.sentAt,
      })
      .returning({ id: messages.id });

    const messageId = insertedMessage[0]!.id;

    // With the message, not after it: once the message has committed, a retry
    // finds it by its mid and stops, so a download that failed to queue after
    // the commit would never be queued at all. Everything left to run after
    // the commit logs its own failures rather than throwing.
    await queueAttachments(tx, messageId, message.attachments);

    await tx
      .update(conversations)
      .set(customerWroteSet(message.sentAt))
      .where(eq(conversations.id, conversationId));

    return { conversationId, conversationNumber, messageId, createdConversation };
  });

  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: message.text,
    kind: 'reply',
    direction: 'inbound',
  });

  await afterInboundMessage(result.conversationId, result.createdConversation, message.sentAt, {
    id: result.messageId,
  });

  return { ...result, duplicate: false };
}

// --- Comments ---------------------------------------------------------------

export async function ingestMetaComment(comment: NormalisedComment): Promise<MetaIngestResult> {
  const existingMessage = await findByChannelMessageId(comment.commentId);
  if (existingMessage) return existingMessage;

  const { contactId } = await resolveContact({
    channel: comment.platform,
    identifier: comment.from || `unknown:${comment.commentId}`,
    displayName: comment.fromName,
  });

  // A comment is a channel of its own (`db/schema/enums.ts`), so a team can
  // route and report public comments apart from direct messages; the person
  // stays on the platform, above, because the commenter is the same user who
  // writes to the inbox. The database refuses a comment ticket on any other
  // channel (`db/sql/008_comment_channel_check.sql`).
  const commentChannel = commentChannelOf(comment.platform);

  // The root of the thread is what the ticket is about. A reply to a comment
  // belongs on the same ticket as the comment it answers.
  const rootId = comment.parentCommentId ?? comment.commentId;
  const externalId = `${comment.platform}:comment:${rootId}`;

  const existing = await findByExternalId(externalId);
  // Read only for a thread that opens a ticket: a reply joining one keeps the
  // ticket's row and group, and on a busy post that is most comments.
  const channel = existing ? null : await channelFor(commentChannel);

  const result = await db.transaction(async (tx) => {
    let conversationId: string;
    let conversationNumber: number;
    let createdConversation = false;

    if (existing) {
      conversationId = existing.id;
      conversationNumber = existing.number;

      if (existing.statusCategory === 'resolved') {
        await reopenResolved(
          tx,
          { id: conversationId, reopenCount: existing.reopenCount },
          { actorLabel: `inbound_${comment.platform}`, reason: 'customer_replied' },
        );
      }

      // The thread's own first comment, arriving after a reply under it opened
      // the ticket — a batch retried whole, or a delivery processed late. Its
      // author is who the thread is about, and who the requester would have
      // been had it arrived first, so they become it. Left on the replier,
      // every reader that answers the requester and nobody else — the
      // out-of-hours acknowledgement (`answersRequester`), the language
      // automated replies go out in (`requesterLocale`) and the console's
      // private reply — would treat the customer as a passer-by on their own
      // thread, and the passer-by as the customer. A reply's author never
      // takes it: they are somebody under the customer's comment.
      if (!comment.parentCommentId) {
        await adoptRootAuthor(tx, {
          conversationId,
          previous: existing.requesterContactId,
          authorContactId: contactId,
          platform: comment.platform,
          rootCommentId: rootId,
        });
      }
    } else {
      const statusId = await requireDefaultOpenStatusId(tx);

      const inserted = await tx
        .insert(conversations)
        .values({
          channel: commentChannel,
          channelId: channel?.id ?? null,
          statusId,
          subject: subjectFrom(comment.text, UNNAMED_SUBJECT[`${comment.platform}Comment`]),
          requesterContactId: contactId,
          groupId: channel?.defaultGroupId ?? null,
          externalId,
          lastMessageAt: comment.createdAt,
          lastCustomerMessageAt: comment.createdAt,
        })
        .returning({ id: conversations.id, number: conversations.number });

      conversationId = inserted[0]!.id;
      conversationNumber = inserted[0]!.number;
      createdConversation = true;

      await tx.insert(conversationEvents).values({
        conversationId,
        type: 'comment_thread_opened',
        actorLabel: `inbound_${comment.platform}`,
        data: { postId: comment.postId, rootCommentId: rootId },
      });
    }

    const insertedMessage = await tx
      .insert(messages)
      .values({
        conversationId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contactId,
        bodyText: comment.text || '[empty comment]',
        bodyHtml: null,
        rawBody: JSON.stringify(comment.raw),
        // The comment id is the idempotency key, and it is also what an agent's
        // public reply is posted against.
        channelMessageId: comment.commentId,
        inReplyTo: comment.parentCommentId,
        fromAddress: comment.from || null,
        deliveryStatus: 'delivered',
        deliveredAt: comment.createdAt,
        meta: {
          metaKind: 'comment',
          platform: comment.platform,
          connection: comment.connection,
          commentId: comment.commentId,
          parentCommentId: comment.parentCommentId,
          postId: comment.postId,
          isPublic: true,
        },
        createdAt: comment.createdAt,
      })
      .returning({ id: messages.id });

    // A reply processed before the comment it answers is the newer of the two.
    await tx
      .update(conversations)
      .set(customerWroteSet(comment.createdAt))
      .where(eq(conversations.id, conversationId));

    return {
      conversationId,
      conversationNumber,
      messageId: insertedMessage[0]!.id,
      createdConversation,
    };
  });

  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: comment.text,
    kind: 'reply',
    direction: 'inbound',
  });

  await afterInboundMessage(result.conversationId, result.createdConversation, comment.createdAt, {
    id: result.messageId,
  });

  return { ...result, duplicate: false };
}

// --- Interactions -----------------------------------------------------------

/**
 * Something the customer did that opens the window — a message, a comment, a
 * postback — as a `set` object: both columns moved forward to its instant,
 * and never back. Exported so a test can assert what it binds.
 *
 * Forward only, as email's and WhatsApp's columns are, because deliveries are
 * processed in no order (§6.77) and a batch with an item that failed is run
 * again whole, so the item that failed lands after siblings newer than it.
 * Written plainly, the older one would drag the ticket down the list and the
 * messaging window shut early. The reply clock started after it reads the
 * column back under the ticket's lock (`onCustomerReply`), for the same reason.
 *
 * The instant is interpolated as an ISO string with an explicit cast, never as a
 * `Date`. A bare Date in a `sql` template reaches postgres.js as an untyped
 * parameter, which it cannot serialise — it assumes text and throws
 * `ERR_INVALID_ARG_TYPE`; drizzle only maps a Date when a typed operator tells
 * it which column it is being compared against, and a template does not.
 * `staleTemplateFilter` carries the same note and the same kind of test, and
 * `lib/reports/live.ts` works around the same wall.
 *
 * Worth a test rather than a comment because nothing else would catch it:
 * `applyMetaInteraction` is reachable only through `process_meta_webhook`, which
 * the `database` CI job does not run, so no Postgres ever plans this statement
 * before production does.
 *
 * `greatest` is documented as ignoring nulls in its list, so a conversation
 * whose customer has never written takes the instant given.
 */
export function customerWroteSet(at: Date) {
  return {
    lastMessageAt: latest(conversations.lastMessageAt, at),
    lastCustomerMessageAt: latest(conversations.lastCustomerMessageAt, at),
  };
}

/**
 * A customer touching the thread without writing: a button, an ad click, a
 * reaction.
 *
 * Three decisions, and each of them is a thing this could get wrong invisibly:
 *
 * **It writes no `messages` row.** None of these is something an agent can
 * answer, and a reaction rendered as an inbound reply would be subcategorised
 * as support demand, counted in the volume a manager staffs from, and shown to
 * an agent as a question. The `conversation_events` row is what a person reads
 * instead — it explains why a window is open, or why the customer went quiet
 * after a thumbs-up.
 *
 * **It creates no conversation.** A bare Get Started is a ticket with nothing in
 * it to answer, opening a first-response SLA clock against a question nobody
 * asked. The customer's actual message arrives seconds later on the same thread
 * and opens the ticket properly, carrying its own subject. If it never arrives,
 * there was nothing to answer.
 *
 * **Only `opensWindow` moves `lastCustomerMessageAt`**, which is the column both
 * the Meta messaging window and the next-response SLA target are measured from.
 * A postback or a referral is somebody asking for something, so both are right.
 * A reaction is not, so it moves nothing — see the note on the flag in
 * `lib/meta/parse.ts`.
 *
 * Returns whether anything was written, for the job's log line.
 */
export async function applyMetaInteraction(interaction: NormalisedInteraction): Promise<boolean> {
  // Looked up rather than resolved: `resolveContact` writes a contact when it
  // finds none, and an interaction has nothing to file under one. A stranger
  // pressing Get Started would leave a contact row with no ticket and no
  // message, one per press.
  const contactId = await findContactByIdentity(interaction.platform, interaction.from);
  if (!contactId) return false;

  const existing = await findLiveConversation(contactId, { channel: interaction.platform });
  if (!existing) return false;

  const type = `meta_${interaction.kind}`;

  // The idempotency every other path in this module has and this one lacked.
  // `deliveryId` deliberately keys a delivery *by connection*, so the two live
  // Instagram connections each store and process their own copy of the same
  // event — which costs nothing for a message, because `ingestMetaMessage`
  // dedupes on the mid, and cost this one a duplicate timeline row per press.
  // The instant is the key: Meta sends the same `timestamp` on a redelivery and
  // on both connections' copies, and one customer cannot press the same kind of
  // button twice in the same millisecond.
  const already = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, existing.id),
        eq(conversationEvents.type, type),
        eq(conversationEvents.createdAt, interaction.at),
      ),
    )
    .limit(1);

  if (already.length > 0) return false;

  await db.transaction(async (tx) => {
    await tx.insert(conversationEvents).values({
      conversationId: existing.id,
      type,
      actorLabel: `inbound_${interaction.platform}`,
      data: {
        summary: interaction.summary,
        connection: interaction.connection,
        standby: interaction.standby,
        opensWindow: interaction.opensWindow,
        // The button's machine-readable identity, which the summary is not: two
        // menu branches can carry the same title, and "which branch did they
        // take" is the only question this event can answer later.
        payload: interaction.payload,
      },
      createdAt: interaction.at,
    });

    if (!interaction.opensWindow) return;

    // A resolved ticket is reopened, exactly as an inbound message reopens one.
    // Moving the window on a resolved ticket without reopening it would leave a
    // customer who has come back sitting in no queue, with the only trace an
    // activity line in the sidebar of a ticket nobody has open.
    if (existing.statusCategory === 'resolved') {
      await reopenResolved(
        tx,
        { id: existing.id, reopenCount: existing.reopenCount },
        { actorLabel: `inbound_${interaction.platform}`, reason: 'customer_replied' },
      );
    }

    // Never backwards: a Get Started replayed after the customer's question must
    // not wind the window, or the next-response target derived from it, back to
    // before the question was asked. See `customerWroteSet`.
    await tx
      .update(conversations)
      .set(customerWroteSet(interaction.at))
      .where(eq(conversations.id, existing.id));
  });

  // The next-response clock, restarted the same way an inbound message restarts
  // it. Moving `lastCustomerMessageAt` alone would not: the target is a stored
  // column and `onCustomerReply` is its only writer, so without this the ticket
  // would show as awaiting us in the live queue while carrying no due date —
  // and the reason a reaction is excluded from all of this ("measuring an agent
  // as late for not answering 👍") would describe a clock that was never wound.
  // Outside the transaction and best-effort, exactly as `afterInboundMessage`
  // calls it.
  if (interaction.opensWindow) await onCustomerReply(existing.id, interaction.at);

  return true;
}

// --- Receipts ---------------------------------------------------------------

/**
 * Applies a delivery or read receipt.
 *
 * Only ever moves forward through sent → delivered → read, because Meta sends
 * them out of order often enough that a naive write would show a message going
 * backwards from read to delivered.
 */
const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };

export async function applyMetaReceipt(receipt: NormalisedReceipt): Promise<number> {
  if (receipt.mids.length === 0) return 0;

  let updated = 0;

  for (const mid of receipt.mids) {
    const rows = await db
      .select({ id: messages.id, deliveryStatus: messages.deliveryStatus })
      .from(messages)
      .where(eq(messages.channelMessageId, mid))
      .limit(1);

    const message = rows[0];
    if (!message) continue;

    const current = STATUS_RANK[message.deliveryStatus] ?? 0;
    const next = STATUS_RANK[receipt.kind] ?? 0;
    if (next <= current) continue;

    await db
      .update(messages)
      .set({
        deliveryStatus: receipt.kind,
        ...(receipt.kind === 'delivered' ? { deliveredAt: new Date() } : { readAt: new Date() }),
      })
      .where(eq(messages.id, message.id));

    updated += 1;
  }

  return updated;
}

// --- Shared -----------------------------------------------------------------

async function findByChannelMessageId(channelMessageId: string): Promise<MetaIngestResult | null> {
  const rows = await db
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      number: conversations.number,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.channelMessageId, channelMessageId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    conversationId: row.conversationId,
    conversationNumber: row.number,
    messageId: row.messageId,
    createdConversation: false,
    duplicate: true,
  };
}

type FoundConversation = {
  id: string;
  number: number;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  reopenCount: number;
  requesterContactId: string;
};

/**
 * Makes the author of a thread's root comment the requester of the ticket a
 * reply under it opened, and says so on the timeline.
 *
 * Conditional on the requester still being somebody else, so a second run —
 * the root's batch retried — writes nothing and records nothing. `previous`
 * is what the ticket was found with, outside the transaction: the event's
 * account of who it moved from, where the condition is what decides whether
 * it moves at all.
 */
async function adoptRootAuthor(
  tx: typeof db,
  input: {
    conversationId: string;
    previous: string;
    authorContactId: string;
    platform: NormalisedComment['platform'];
    rootCommentId: string;
  },
): Promise<void> {
  const moved = await tx
    .update(conversations)
    .set({ requesterContactId: input.authorContactId })
    .where(
      and(
        eq(conversations.id, input.conversationId),
        ne(conversations.requesterContactId, input.authorContactId),
      ),
    )
    .returning({ id: conversations.id });
  if (moved.length === 0) return;

  await tx.insert(conversationEvents).values({
    conversationId: input.conversationId,
    type: 'requester_changed',
    actorLabel: `inbound_${input.platform}`,
    data: {
      reason: 'thread_root',
      from: input.previous,
      to: input.authorContactId,
      rootCommentId: input.rootCommentId,
    },
  });
}

/**
 * The ticket a comment thread is filed on, by its `<platform>:comment:<root>`.
 *
 * It skips a soft-deleted ticket as every read does, but this is the one lookup
 * a unique index answers as well: `conversations_external_idx` covers
 * `(source_system, external_id)` with deleted rows included. Nothing sets
 * `conversations.deleted_at` yet — a purge deletes the row, which frees its
 * place in the index — but once `ticket.delete` does, the next comment under a
 * deleted thread finds nothing here, inserts the same pair, fails 23505, and
 * takes its Meta batch with it on every retry until the job is dead. So the
 * change that gives `ticket.delete` an action decides here what that comment
 * does: reopen the hidden ticket, land on it, or open a new one under a narrower
 * index. `ticket.merge` has the same question: this does not skip a merged
 * ticket, so a comment lands on the one merged away unless it follows
 * `merged_into_id`.
 */
async function findByExternalId(externalId: string): Promise<FoundConversation | null> {
  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      statusCategory: ticketStatuses.category,
      reopenCount: conversations.reopenCount,
      requesterContactId: conversations.requesterContactId,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(and(eq(conversations.externalId, externalId), isNull(conversations.deletedAt)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The channel row a new ticket starts from: its default group, and the row it
 * records in `channel_id`.
 *
 * A comment channel falls back to its platform's row, so until an admin adds a
 * "Facebook comments" or "Instagram comments" row a comment ticket starts where
 * it always did, in the Facebook or Instagram row's group. One query for both
 * rather than a second on a miss, picked here in order: the comment row first,
 * then the platform's.
 */
async function channelFor(type: MetaChannel) {
  const candidates = isCommentChannel(type) ? [type, metaPlatformOf(type)] : [type];

  // Ordered, as `webchatChannel` is (`lib/widget/session.ts`): nothing stops an
  // admin adding a second row of a type, and without an order Postgres may hand
  // back either — so which group a new ticket starts in would depend on the
  // plan Postgres happened to pick. Oldest wins, the row that has been routing.
  const rows = await db
    .select({ id: channels.id, type: channels.type, defaultGroupId: channels.defaultGroupId })
    .from(channels)
    .where(and(inArray(channels.type, candidates), eq(channels.isActive, true)))
    .orderBy(asc(channels.createdAt), asc(channels.id));

  for (const candidate of candidates) {
    const row = rows.find((found) => found.type === candidate);
    if (row) return { id: row.id, defaultGroupId: row.defaultGroupId };
  }
  return null;
}

/** First line, trimmed to something that fits a ticket list. */
function subjectFrom(text: string, fallback: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return fallback;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
}

/**
 * Meta's attachment URLs expire, so they are copied into our own storage
 * immediately rather than when an agent opens the ticket.
 */
async function queueAttachments(
  tx: NonNullable<EnqueueOptions['on']>,
  messageId: string,
  attachments: { type: string; url: string | null }[],
): Promise<void> {
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.url) continue;

    await enqueue(
      'download_media',
      { messageId, url: attachment.url, index, source: 'meta' },
      { priority: 5, dedupeKey: `download_media:${messageId}:${index}`, on: tx },
    );
  }
}

/**
 * Asks Meta who this person is, once per person.
 *
 * Direct messages only. A comment already arrives with a name on Facebook and a
 * handle on Instagram, so there is nothing to look up — and a comment author's
 * id is not the page-scoped id the User Profile API answers for, so asking
 * would produce a refusal indistinguishable from "this app is not approved",
 * which is the one signal here that has to stay trustworthy.
 *
 * **No dedupe key**, though one per person is the obvious choice and was the
 * first thing written here. `jobs_dedupe_idx` is a plain unique index over the
 * whole table, so a key is spent permanently rather than until its job finishes:
 * the first lookup for a customer would burn `fetch_meta_profile:facebook:<id>`
 * forever, and every later attempt — the customer writing in again, the backfill
 * run after App Review finally grants the feature — would silently collapse onto
 * a row that completed months ago and do nothing. A job that reached `dead` is
 * never cleaned up at all, so that person could never be looked up again.
 *
 * The guard is in the handler instead, where it can read what actually happened:
 * a second job for an identity already answered for returns immediately. That
 * costs a cheap indexed read per duplicate and keeps the recovery path working,
 * which is the trade worth making.
 */
async function queueProfileLookup(
  platform: MetaPlatform,
  contactId: string,
  userId: string,
): Promise<void> {
  await enqueue('fetch_meta_profile', { contactId, platform, userId }, { priority: 20 });
}
