import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  attachments as attachmentsTable,
  channels,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { env } from '@/lib/env';
import { readEmailBody } from '@/lib/email/body';
import { classifyAutomation, isSelfAddressed } from '@/lib/email/loop-protection';
import { resolveThread, stripSubjectPrefixes } from '@/lib/email/threading';
import type { ParsedInboundEmail } from '@/lib/email/types';
import { ingestSideReply, resolveSideConversation } from '@/lib/side-conversations/ingest';
import { buildAttachmentPath, uploadObject } from '@/lib/storage';
import { resolveContact } from './contacts';
import { afterInboundMessage, afterMessageStored } from './lifecycle';
import { defaultOpenStatusId } from './statuses';

export type IngestResult = {
  conversationId: string;
  conversationNumber: number;
  messageId: string;
  createdConversation: boolean;
  /** Set when the message was already ingested; nothing was written. */
  duplicate: boolean;
  automationReason: string | null;
  /**
   * Set when the mail was a reply on a side conversation rather than from the
   * customer. Nothing below `findConversation` ran: no contact was resolved, no
   * SLA clock moved, no automation fired.
   */
  sideConversationNumber?: number;
};

/**
 * Turns a parsed inbound email into a ticket, or appends it to an existing one.
 *
 * Runs on the worker rather than in the webhook handler, so a slow attachment
 * upload can never cause the provider to time out and redeliver.
 */
export async function ingestInboundEmail(email: ParsedInboundEmail): Promise<IngestResult | null> {
  const secret = env().APP_SECRET;

  // A forwarding loop that makes us the sender would otherwise create tickets
  // from our own replies, forever.
  const ourAddresses = [env().EMAIL_FROM_ADDRESS].filter((a): a is string => Boolean(a));
  if (ourAddresses.length && isSelfAddressed(email, ourAddresses)) {
    console.warn(`[ingest] dropping self-addressed mail from ${email.from.address}`);
    return null;
  }

  const automation = classifyAutomation(email);

  /*
   * Side conversations are resolved first — before `resolveContact` below, and
   * that ordering is load-bearing rather than tidy.
   *
   * The sender of a side conversation reply is a colleague at a hub, a warehouse
   * or a vendor. `resolveContact` would create them a `contacts` row, which is
   * the customer table: they would show up in the customer list, be linkable to
   * shipping accounts, and be able to register for the customer portal against
   * an address we had verified for them. Nothing downstream would ever notice,
   * because every one of those is a legitimate thing to do with a contact.
   *
   * So the branch happens here, at the top, where it is impossible to reach the
   * rest of this function by accident.
   */
  const side = await resolveSideConversation(email);
  if (side) {
    const result = await ingestSideReply(side, email);
    return {
      conversationId: result.conversationId,
      conversationNumber: result.conversationNumber,
      messageId: result.messageId,
      createdConversation: false,
      duplicate: result.duplicate,
      automationReason: automation.reason,
      sideConversationNumber: result.sideConversationNumber,
    };
  }

  // Idempotency. The provider retries on any non-2xx, and webhook_events can be
  // replayed by hand, so the same Message-ID must never produce two messages.
  const alreadySeen = await db
    .select({ id: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.channelMessageId, email.messageId))
    .limit(1);

  if (alreadySeen[0]) {
    const existing = await db
      .select({ number: conversations.number })
      .from(conversations)
      .where(eq(conversations.id, alreadySeen[0].conversationId))
      .limit(1);

    return {
      conversationId: alreadySeen[0].conversationId,
      conversationNumber: existing[0]?.number ?? 0,
      messageId: alreadySeen[0].id,
      createdConversation: false,
      duplicate: true,
      automationReason: automation.reason,
    };
  }

  const { contactId } = await resolveContact({
    channel: 'email',
    identifier: email.from.address,
    displayName: email.from.name ?? null,
  });

  const existingConversation = await findConversation(email, secret);

  // --- Body: strip quotes, sanitise, derive text ---------------------------

  const body = readEmailBody(email);

  const emailChannel = await defaultEmailChannel();

  const result = await db.transaction(async (tx) => {
    let conversationId: string;
    let conversationNumber: number;
    let createdConversation = false;

    if (existingConversation) {
      conversationId = existingConversation.id;
      conversationNumber = existingConversation.number;

      // A reply to a resolved ticket reopens it — otherwise a customer's
      // follow-up disappears from every agent's open queue. An autoresponder
      // does not: the out-of-office answering the agent's closing reply would
      // put a finished ticket back in the queue and count a reopen against
      // whoever resolved it. It is still stored below, on the timeline.
      if (existingConversation.statusCategory === 'resolved' && !automation.isAutoReply) {
        const reopenTo = await defaultOpenStatusId(tx);
        if (reopenTo) {
          // `resolvedByAgentId` is deliberately not cleared here, so it survives
          // to be read back below.
          const reopened = await tx
            .update(conversations)
            .set({
              statusId: reopenTo,
              resolvedAt: null,
              reopenCount: existingConversation.reopenCount + 1,
            })
            .where(eq(conversations.id, conversationId))
            .returning({ resolvedBy: conversations.resolvedByAgentId });

          await tx.insert(conversationEvents).values({
            conversationId,
            type: 'reopened',
            actorLabel: 'inbound_email',
            // The resolver is snapshotted onto the event rather than looked up
            // later. `conversations.resolved_by_agent_id` is overwritten by the
            // next resolution, and the nightly rollup rebuilds the last three
            // days — so reading it at report time would let a ticket resolved
            // again by somebody else silently move this reopening onto them.
            data: { reason: 'customer_replied', resolvedBy: reopened[0]?.resolvedBy ?? null },
          });
        }
      }
    } else {
      const statusId = await defaultOpenStatusId(tx);
      if (!statusId) {
        throw new Error('No default open ticket status configured — run `npm run db:seed`');
      }

      const inserted = await tx
        .insert(conversations)
        .values({
          channel: 'email',
          channelId: emailChannel?.id ?? null,
          statusId,
          subject: stripSubjectPrefixes(email.subject) || '(no subject)',
          requesterContactId: contactId,
          groupId: emailChannel?.defaultGroupId ?? null,
          // A bounce or autoresponder is filed but kept out of the working queue.
          isSpam: automation.isBounce || automation.isAutoReply,
          lastMessageAt: email.receivedAt,
          lastCustomerMessageAt: email.receivedAt,
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
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyText,
        // The untouched original, so a wrong strip is recoverable.
        rawBody: body.rawBody,
        channelMessageId: email.messageId,
        inReplyTo: email.inReplyTo ?? null,
        fromAddress: email.from.address,
        toAddresses: email.to.map((a) => a.address),
        ccAddresses: email.cc.map((a) => a.address),
        deliveryStatus: 'delivered',
        meta: {
          automationReason: automation.reason,
          isAutomated: automation.isAutomated,
          isBounce: automation.isBounce,
          isAutoReply: automation.isAutoReply,
          strippedBy: body.strippedBy,
          spfPass: email.spfPass,
          spamScore: email.spamScore,
        },
        createdAt: email.receivedAt,
      })
      .returning({ id: messages.id });

    const messageId = insertedMessage[0]!.id;

    // An autoresponder is not the customer writing, so it does not move the
    // time the customer last wrote — only the time anything last arrived.
    await tx
      .update(conversations)
      .set(
        automation.isAutoReply
          ? { lastMessageAt: email.receivedAt }
          : { lastMessageAt: email.receivedAt, lastCustomerMessageAt: email.receivedAt },
      )
      .where(eq(conversations.id, conversationId));

    return { conversationId, conversationNumber, messageId, createdConversation };
  });

  // Attachments are uploaded after the transaction commits: a slow or failing
  // upload must not roll back the message, which is the part that matters.
  await storeAttachments(result.conversationId, result.messageId, email);

  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: body.bodyText,
    kind: 'reply',
    direction: 'inbound',
  });

  await afterInboundMessage(result.conversationId, result.createdConversation, email.receivedAt, {
    autoReply: automation.isAutoReply,
  });

  return {
    ...result,
    duplicate: false,
    automationReason: automation.reason,
  };
}

type FoundConversation = {
  id: string;
  number: number;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  reopenCount: number;
};

/** Applies the resolved thread signal to find the actual conversation row. */
async function findConversation(
  email: ParsedInboundEmail,
  secret: string,
): Promise<FoundConversation | null> {
  const match = resolveThread(email, secret);

  const select = () =>
    db
      .select({
        id: conversations.id,
        number: conversations.number,
        statusCategory: ticketStatuses.category,
        reopenCount: conversations.reopenCount,
      })
      .from(conversations)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId));

  if (match.kind === 'reply_token' || match.kind === 'subject_tag') {
    const rows = await select()
      .where(
        and(eq(conversations.number, match.conversationNumber), isNull(conversations.deletedAt)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  if (match.kind === 'references') {
    // Match any ancestor we have stored. Ordered by recency so a message quoted
    // across two merged threads resolves to the live one.
    const rows = await select()
      .innerJoin(messages, eq(messages.conversationId, conversations.id))
      .where(
        and(inArray(messages.channelMessageId, match.messageIds), isNull(conversations.deletedAt)),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  return null;
}

async function defaultEmailChannel() {
  const rows = await db
    .select({ id: channels.id, defaultGroupId: channels.defaultGroupId })
    .from(channels)
    .where(and(eq(channels.type, 'email'), eq(channels.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

async function storeAttachments(
  conversationId: string,
  messageId: string,
  email: ParsedInboundEmail,
): Promise<void> {
  if (email.attachments.length === 0) return;

  for (const [index, attachment] of email.attachments.entries()) {
    try {
      const path = buildAttachmentPath(
        conversationId,
        `${messageId}-${index}`,
        attachment.filename,
      );
      const stored = await uploadObject(path, attachment.content, attachment.contentType);

      await db.insert(attachmentsTable).values({
        messageId,
        storagePath: stored.path,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
        contentId: attachment.contentId ?? null,
        isInline: attachment.isInline,
      });
    } catch (error) {
      // One bad attachment must not lose the message it came with; the body is
      // already committed and an agent can ask the customer to resend.
      console.error(`[ingest] attachment "${attachment.filename}" failed for ${messageId}`, error);
    }
  }
}
