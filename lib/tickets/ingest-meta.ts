import { and, asc, eq, inArray, isNull, lte, max, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, conversationEvents, conversations, messages, ticketStatuses } from '@/db/schema';
import { echoSourceOf } from '@/lib/meta/echo';
import type {
  MetaPlatform,
  NormalisedComment,
  NormalisedDirectMessage,
  NormalisedEcho,
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
import { onAgentReply, onCustomerReply } from '@/lib/sla';
import { findContactByIdentity, needsChannelProfile, resolveContact } from './contacts';
import { UNNAMED_SUBJECT } from './customer-text';
import { latest } from './latest';
import { afterInboundMessage, afterMessageStored } from './lifecycle';
import { findLiveConversation } from './live-conversation';
import { reopenResolved } from './reopen';
import { requireDefaultOpenStatusId } from './statuses';
import { runAutomations } from '@/lib/automations';
import { afterHoldEnded } from '@/lib/routing/after-hold';
import { endHold } from '@/lib/routing/end-hold';
import { planRouting, routingWindowValues, startRouting } from '@/lib/routing/start';

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
  // Before the transaction, which must read nothing on the pool (`lib/routing/start.ts`).
  const routing = existing ? null : await planRouting(channel);

  const result = await db.transaction(async (tx) => {
    let conversationId: string;
    let conversationNumber: number;
    let createdConversation = false;
    // When this was processed, which a routing window counts from, never the
    // message's own `sentAt`: one instant for the window on the insert and the
    // row and job beside it.
    const now = new Date();

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
          // Held for the router from the insert (`lib/routing/start.ts`).
          ...routingWindowValues(routing, {}, now),
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
          // Which Meta connection delivered this. Recorded beside `standby`
          // rather than instead of it, because it is what makes the flag
          // readable: a standby reported by the Page connection refuses a send
          // from this app over the Page or Unified Login (§6.108), and has not
          // been seen to say anything about one sent with the Instagram
          // account's own token over Instagram Login (§6.29).
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

    if (createdConversation) {
      await startRouting(
        tx,
        routing,
        { conversationId, messageId, groupId: channel?.defaultGroupId ?? null },
        now,
      );
    }

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
  // Until a comment row exists the ticket is filed under the platform's direct
  // message row, and routes by that row's mode.
  const routing = existing ? null : await planRouting(channel);
  const subject = subjectFrom(comment.text, UNNAMED_SUBJECT[`${comment.platform}Comment`]);

  const result = await db.transaction(async (tx) => {
    let conversationId: string;
    let conversationNumber: number;
    let createdConversation = false;
    // When this was processed, which a routing window counts from, never the
    // comment's own `createdAt` — as on a direct message.
    const now = new Date();

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
      // out-of-hours acknowledgement (`answersRequester`), and the one a
      // routing hold kept back, which answers this comment once the hold ends
      // (`heldFollowUp`); the language automated replies go out in
      // (`requesterLocale`); the console's private reply — would treat the
      // customer as a passer-by on their own thread, and the passer-by as the
      // customer. A reply's author never takes it: they are somebody under the
      // customer's comment.
      if (!comment.parentCommentId) {
        await adoptRootAuthor(tx, {
          conversationId,
          authorContactId: contactId,
          subject,
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
          subject,
          requesterContactId: contactId,
          groupId: channel?.defaultGroupId ?? null,
          externalId,
          lastMessageAt: comment.createdAt,
          lastCustomerMessageAt: comment.createdAt,
          // Held for the router from the insert (`lib/routing/start.ts`).
          ...routingWindowValues(routing, {}, now),
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

    if (createdConversation) {
      await startRouting(
        tx,
        routing,
        {
          conversationId,
          messageId: insertedMessage[0]!.id,
          groupId: channel?.defaultGroupId ?? null,
        },
        now,
      );
    }

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

// --- Echoes -----------------------------------------------------------------

/**
 * What became of an echo `echoDisposition` passed on. Filed now, or before
 * (`duplicate`), on a ticket; or not filed, and why. `no_ticket`: the customer
 * has no contact or no live direct-message ticket here — yet, possibly, which
 * is why the job retries it while one of the customer's deliveries is still
 * waiting (`process-meta-webhook.ts`). `predates_ticket`: every customer
 * message on their live ticket is newer than the echo, so it answered an
 * earlier, closed conversation. `too_quick`: sent within
 * `TYPED_REPLY_FLOOR_MS` of the customer's message before it, as only an
 * automation is.
 */
export type MetaEchoResult =
  | {
      outcome: 'filed' | 'duplicate';
      conversationId: string;
      conversationNumber: number;
      messageId: string;
    }
  | { outcome: 'no_ticket' | 'predates_ticket' | 'too_quick' };

/**
 * The quickest a person answers in Business Suite, as measured. Every Page
 * Inbox echo kept to 2026-11-12 was timed against the customer's message
 * before it: of 220, two came sooner than 10 s — a card at 4.9 s and a
 * 270-character "thanks for contacting us" at 8.6 s, both shaped like an
 * automation — and the quickest typed reply took 13.2 s. Business Suite's own
 * automations (an instant reply, an away message) echo under the same app id
 * as a person's reply, and Instagram's welcome went 2–5.4 s after the
 * customer. A reply refused here leaves the ticket unanswered, which a person
 * sees; one filed wrongly reads as answered, which nobody does.
 */
const TYPED_REPLY_FLOOR_MS = 10_000;

/**
 * The team's reply typed somewhere other than this console — Meta Business
 * Suite, on any Messenger thread — filed from its echo as the
 * team's reply, the way a coexistence number's phone reply is
 * (`ingestWhatsAppEcho`). Only an echo `echoDisposition` files reaches here:
 * our own sends stay dropped, since `send_meta` wrote their rows, and so does
 * Instagram, which names no app (`lib/meta/echo.ts`).
 *
 * Measured before it was written: from 09:50 UTC on 2026-11-11 Meta hands every
 * new Messenger thread to this app, and the team answers them in Business
 * Suite. By 15:15 the next day 19 such replies had come back as echoes, on 8
 * tickets, and every one was dropped — so each ticket read as unanswered, its
 * clocks running, and one answered at 12:29 on the 11th recorded its first
 * response at 14:39 on the 12th (`docs/PROJECT-STATE.md` §6.117).
 *
 * What it writes, and why each half is the shape it is:
 *
 * - **An outbound reply with no author.** No agent here wrote it, so
 *   `author_agent_id` stays null — which is also what keeps `HUMAN_AGENT` off
 *   anything derived from it: `send_meta` reads the author of the row it is
 *   sending, and this row is never sent (`deliveryStatus` 'sent', no job).
 *   `meta.echoSource` names where it was typed, which the thread labels
 *   (`teamEchoLabel`), and `meta.echoAppId` the app Meta named.
 * - **`last_agent_message_at` forward only, never `last_customer_message_at`.**
 *   `latest()`, because a Meta batch is retried whole and the echo can land
 *   after a newer sibling; and the customer's column opens the messaging
 *   window, which only the customer can do. A resolved ticket stays resolved:
 *   the team's own message never makes a ticket need attention.
 * - **`onAgentReply` after the commit**, which stops the next-response clock
 *   only for what came before the reply and keeps the earliest first response,
 *   so the SLA does not depend on the order deliveries are processed in.
 *
 * It files onto the customer's live direct-message ticket and never opens one.
 * A ticket opened by the team's message would sit in the queue asking nothing
 * (WhatsApp files those resolved; here, where an inbound message does not lock
 * its thread, a ticket opened beside the customer's own would be two). One of
 * the 19 above had no contact here at all. Finding no ticket is not final,
 * though: Meta sends every Messenger event in a delivery of its own (838 of 838
 * Page deliveries to 2026-11-12), and Business Suite answered one thread 4.9 s
 * after its first message, so the customer's message can still be waiting on
 * its own retry, or running beside this one after a deploy, when the reply is
 * processed. So `no_ticket` is answered, and the job retries the delivery
 * while one of the customer's own is still waiting to be processed.
 *
 * And it files only onto a ticket the reply can have answered: one with a
 * customer message no newer than the echo. A follow-up sent in Business Suite
 * to a customer whose ticket was closed, processed after the customer's answer
 * opened a new one, would otherwise land on that new ticket as its first
 * response, before the question it is supposed to answer. Nor onto one whose
 * customer wrote less than 10 seconds before it: no person in Business Suite
 * has answered that fast, and its automations do (`TYPED_REPLY_FLOOR_MS`).
 *
 * And it ends a routing hold as an agent's reply does (`storeAgentReply`): a
 * person answered, so the ticket stays in its group and the hold's follow-ups
 * run. Facebook's row routes by `default_group` (2026-11-12), but nothing
 * stops an admin moving it to `category`, and a held ticket answered in
 * Business Suite would otherwise read "Routing…" until its window ended.
 *
 * Idempotent by its mid, as a message is; two copies racing past the lookup
 * meet the unique index on `channel_message_id`, which fails the batch for its
 * retry to find the row.
 */
export async function ingestMetaEcho(echo: NormalisedEcho): Promise<MetaEchoResult> {
  const [stored] = await db
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      conversationNumber: conversations.number,
      filedEcho: sql<boolean>`${messages.meta}->>'echoSource' is not null`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.channelMessageId, echo.mid))
    .limit(1);
  if (stored) {
    // Again, for a run that committed the row and stopped before what follows
    // it — a deploy's shutdown — which every later run would otherwise answer
    // "duplicate" and leave owing a reply it was given. Both are safe twice:
    // the same instant changes nothing in the clocks (`earliest`, and the
    // next-response clock decided against the row as it is), and shipment
    // linking writes only a link it did not have. Only for a row this path
    // filed: under a `META_APP_ID` that names the wrong app, our own
    // automated acknowledgement would come back here as another app's, and
    // stopping the clocks on it would say a person had answered.
    if (stored.filedEcho) {
      await onAgentReply(stored.conversationId, echo.sentAt);
      await afterMessageStored({
        conversationId: stored.conversationId,
        messageId: stored.messageId,
        bodyText: echo.text,
        kind: 'reply',
        direction: 'outbound',
      });
    }
    return {
      outcome: 'duplicate',
      conversationId: stored.conversationId,
      conversationNumber: stored.conversationNumber,
      messageId: stored.messageId,
    };
  }

  // Looked up rather than resolved, as an interaction is: the team writing to
  // somebody this app has never heard from is no reason to make them a contact.
  const contactId = await findContactByIdentity(echo.platform, echo.to);
  if (!contactId) return { outcome: 'no_ticket' };

  const live = await findLiveConversation(contactId, { channel: echo.platform });
  if (!live) return { outcome: 'no_ticket' };

  // The customer's newest message the reply can have answered. Both instants
  // are Meta's own (`sentAt`), so the comparisons are on one clock.
  const [answered] = await db
    .select({ at: max(messages.createdAt) })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, live.id),
        eq(messages.direction, 'inbound'),
        lte(messages.createdAt, echo.sentAt),
      ),
    );
  if (!answered?.at) return { outcome: 'predates_ticket' };
  if (echo.sentAt.getTime() - answered.at.getTime() < TYPED_REPLY_FLOOR_MS) {
    return { outcome: 'too_quick' };
  }

  const source = echoSourceOf(echo.appId);
  const { messageId, endedHold } = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(messages)
      .values({
        conversationId: live.id,
        direction: 'outbound',
        kind: 'reply',
        bodyText: echo.text,
        bodyHtml: null,
        rawBody: JSON.stringify(echo.raw),
        channelMessageId: echo.mid,
        inReplyTo: echo.replyToMid,
        // As WhatsApp's echo is written: from the Page, to the customer.
        fromAddress: echo.accountId,
        toAddresses: [echo.to],
        // Meta echoes only what it accepted; a delivery receipt naming the mid
        // moves it on from here (`applyMetaReceipt`).
        deliveryStatus: 'sent',
        meta: {
          metaKind: 'direct_message',
          platform: echo.platform,
          accountId: echo.accountId,
          connection: echo.connection,
          echo: true,
          echoSource: source,
          echoAppId: echo.appId,
          attachments: echo.attachments,
        },
        createdAt: echo.sentAt,
      })
      .returning({ id: messages.id });

    // With the row, for the reason `ingestMetaMessage` gives: once it has
    // committed, a retry finds it by its mid and stops.
    await queueAttachments(tx, inserted!.id, echo.attachments);

    await tx
      .update(conversations)
      .set({
        lastMessageAt: latest(conversations.lastMessageAt, echo.sentAt),
        lastAgentMessageAt: latest(conversations.lastAgentMessageAt, echo.sentAt),
      })
      .where(eq(conversations.id, live.id));

    // A person answering a ticket held for the router has decided for it, in
    // Business Suite as in the console (`storeAgentReply`): the hold ends with
    // the reply, in its transaction, and the ticket stays where it is. Not
    // once the router has written its decision, which is the router's to
    // finish (`endHold` answers false). A no-op on a ticket that never routed.
    const ended = await endHold(tx, live.id, 'manual', {
      label: `echo:${source}`,
      decidesShadow: false,
    });

    return { messageId: inserted!.id, endedHold: ended };
  });

  // After the commit, as `ingestWhatsAppEcho` and `storeAgentReply` do, so a
  // failure here is a logged SLA write and never a lost reply.
  await onAgentReply(live.id, echo.sentAt);

  // What the hold kept back, as after an agent's reply: the assignment, the
  // out-of-hours reply this answer makes moot (its guard skips it), and the
  // `on_update` pass a category written during the hold handed the router.
  if (endedHold) {
    await afterHoldEnded(live.id, new Date(), {
      runOwedPass: () => runAutomations('on_update', live.id),
    });
  }

  // A tracking number typed in Business Suite links its shipment, as the bot's
  // and the phone's do; nothing else in it runs for an outbound reply.
  await afterMessageStored({
    conversationId: live.id,
    messageId,
    bodyText: echo.text,
    kind: 'reply',
    direction: 'outbound',
  });

  return {
    outcome: 'filed',
    conversationId: live.id,
    conversationNumber: live.number,
    messageId,
  };
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
};

/**
 * Makes the author of a thread's root comment the requester of the ticket a
 * reply under it opened, and says so on the timeline.
 *
 * Nothing when the root's author already holds the ticket — their own reply
 * under it arrived first. A redelivered root never gets this far: the
 * comment-id lookup at the top of `ingestMetaComment` returns first, and two
 * copies racing past it are rolled back whole by the unique index on the
 * message they both insert.
 *
 * A contact merge re-points tickets while this runs, so the move is a
 * compare-and-set: read the requester, and write only while it is still the
 * one read, which is the one the event names. A merge that commits first makes
 * the write match nothing, and the next read sees what it left. Not a locked
 * read: that waits out a merge of the root's own author, reads the survivor
 * and hands the ticket back to the contact merged away; and it holds the
 * ticket ahead of the message insert's check of the author's contact, the
 * reverse of the order a merge and a purge lock in, so the two deadlock. A
 * plain read takes no lock at all when nothing moves.
 *
 * Two columns move with it. `requester_kind` is the requester's population,
 * read off their own record once and never revised (`establishRequesterKind`),
 * so left alone it would go on describing the replier; cleared, the root's own
 * `afterMessageStored`, which runs once this commits, reads it off the new
 * requester. And the subject is the opening comment's first line, which here
 * was the replier's: it becomes the root's, as it would have been had the root
 * arrived first. No person writes either column — nothing edits a subject, and
 * the kind's only other writer is the one that reads it afresh — so neither
 * move overrides anybody.
 *
 * Whatever the ticket's state: a closed thread still files later comments
 * here, and the out-of-hours acknowledgement still answers by who the
 * requester is. A root Meta sent without an author makes its placeholder the
 * requester, as it does when that root opens the ticket itself. What was done
 * under the replier stays done — the acknowledgement `answersRequester`
 * describes, and a priority or category Jev read off their words, which no
 * second writer outside the classifiers undoes — but none of it counts as the
 * customer's from here on. Neither classifier counts a run on a message by
 * somebody who is not the requester now as having judged or settled the
 * ticket, and each asks again who the requester is under its own lock on this
 * row, so the root's own answer may lower the priority and settles the
 * category. And the router does not decide on Jev's reading of a reply whose
 * root may still come, nor, at the window's end, on one read off somebody who
 * is no longer the requester (`categoryStanding`, `lib/routing/decide.ts`).
 */
async function adoptRootAuthor(
  tx: typeof db,
  input: {
    conversationId: string;
    authorContactId: string;
    subject: string;
    platform: NormalisedComment['platform'];
    rootCommentId: string;
  },
): Promise<void> {
  // Each lost round is a merge that committed in between, which a person
  // started; a third in a row is not traffic, so it fails the batch to retry.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [ticket] = await tx
      .select({ requesterContactId: conversations.requesterContactId })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId));
    if (!ticket || ticket.requesterContactId === input.authorContactId) return;

    const moved = await tx
      .update(conversations)
      .set({
        requesterContactId: input.authorContactId,
        requesterKind: null,
        subject: input.subject,
      })
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.requesterContactId, ticket.requesterContactId),
        ),
      )
      .returning({ id: conversations.id });
    if (moved.length === 0) continue;

    await tx.insert(conversationEvents).values({
      conversationId: input.conversationId,
      type: 'requester_changed',
      actorLabel: `inbound_${input.platform}`,
      data: {
        reason: 'thread_root',
        from: ticket.requesterContactId,
        to: input.authorContactId,
        rootCommentId: input.rootCommentId,
      },
    });
    return;
  }

  throw new Error(
    `the requester of conversation ${input.conversationId} kept changing under its root comment`,
  );
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
    .select({
      id: channels.id,
      type: channels.type,
      config: channels.config,
      routingMode: channels.routingMode,
      defaultGroupId: channels.defaultGroupId,
    })
    .from(channels)
    .where(and(inArray(channels.type, candidates), eq(channels.isActive, true)))
    .orderBy(asc(channels.createdAt), asc(channels.id));

  for (const candidate of candidates) {
    const row = rows.find((found) => found.type === candidate);
    if (row) return row;
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
