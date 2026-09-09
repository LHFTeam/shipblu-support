import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  attachments as attachmentsTable,
  conversationEvents,
  conversations,
  sideConversationMessages,
  sideConversations,
} from '@/db/schema';
import { env } from '@/lib/env';
import { classifyAutomation } from '@/lib/email/loop-protection';
import { stripQuotedHtml, stripQuotedText } from '@/lib/email/quote-strip';
import { resolveThread } from '@/lib/email/threading';
import type { ParsedInboundEmail } from '@/lib/email/types';
import { htmlToText, sanitiseEmailHtml } from '@/lib/html/sanitize';
import { buildAttachmentPath, uploadObject } from '@/lib/storage';

/**
 * Filing a reply from a hub, a warehouse or another internal team.
 *
 * This runs *before* anything in `lib/tickets/ingest.ts` touches contacts or
 * conversations, and that ordering is the guarantee the whole feature rests on:
 * the person replying here is a colleague at a hub, and if the normal path saw
 * this mail first it would resolve them into `contacts`, where they would appear
 * in the customer list, be attachable to shipping accounts, and be able to
 * register for the customer portal.
 *
 * Nothing downstream of a ticket fires from here. No SLA clock moves, no
 * automation runs, no CSAT is scheduled and no shipment is linked. The hub
 * answering is not the customer replying, and every one of those engines exists
 * to measure or act on the customer.
 *
 * The single exception is `conversations.last_message_at`, which is bumped so
 * the ticket floats back up the inbox when the answer everyone is waiting for
 * finally lands. `last_customer_message_at` and `last_agent_message_at` are left
 * alone: they drive the WhatsApp and Meta send windows and the SLA clocks, and a
 * message the customer never sent must not move them.
 */

export type SideIngestResult = {
  sideConversationId: string;
  sideConversationNumber: number;
  conversationId: string;
  conversationNumber: number;
  messageId: string;
  duplicate: boolean;
};

type ResolvedSide = {
  id: string;
  number: number;
  conversationId: string;
  conversationNumber: number;
  state: 'open' | 'done';
};

/**
 * Does this email belong to a side conversation?
 *
 * Returns null for everything else, and the caller falls through to the normal
 * ticket path. Deliberately separate from `ingestSideReply` so the routing
 * decision is one readable query and the write path is not entangled with it.
 */
export async function resolveSideConversation(
  email: ParsedInboundEmail,
): Promise<ResolvedSide | null> {
  const match = resolveThread(email, env().APP_SECRET);

  const select = () =>
    db
      .select({
        id: sideConversations.id,
        number: sideConversations.number,
        conversationId: sideConversations.conversationId,
        conversationNumber: conversations.number,
        state: sideConversations.state,
      })
      .from(sideConversations)
      .innerJoin(conversations, eq(conversations.id, sideConversations.conversationId));

  if (match.kind === 'side_reply_token' || match.kind === 'side_subject_tag') {
    const rows = await select().where(eq(sideConversations.number, match.sideNumber)).limit(1);
    return rows[0] ?? null;
  }

  if (match.kind === 'references') {
    // Searched before `messages`, for the reason written on `resolveThread`: a
    // mail that somehow quotes both belongs to the internal thread, because the
    // other filing puts a hub's answer where the customer portal can read it.
    const rows = await select()
      .innerJoin(
        sideConversationMessages,
        eq(sideConversationMessages.sideConversationId, sideConversations.id),
      )
      .where(inArray(sideConversationMessages.channelMessageId, match.messageIds))
      .orderBy(desc(sideConversationMessages.createdAt))
      .limit(1);

    return rows[0] ?? null;
  }

  return null;
}

export async function ingestSideReply(
  side: ResolvedSide,
  email: ParsedInboundEmail,
): Promise<SideIngestResult> {
  // Idempotency, against this table only. The provider retries on any non-2xx
  // and webhook_events can be replayed by hand, so the same Message-ID must
  // never append the hub's answer twice.
  const seen = await db
    .select({ id: sideConversationMessages.id })
    .from(sideConversationMessages)
    .where(eq(sideConversationMessages.channelMessageId, email.messageId))
    .limit(1);

  if (seen[0]) {
    return {
      sideConversationId: side.id,
      sideConversationNumber: side.number,
      conversationId: side.conversationId,
      conversationNumber: side.conversationNumber,
      messageId: seen[0].id,
      duplicate: true,
    };
  }

  /*
   * Classified but never acted on.
   *
   * A forwarding list sets List-Id, which this reads as automated. On the
   * customer path that verdict suppresses an auto-reply and can flag a bounce as
   * spam; doing either here would quietly discard the answer an agent is sitting
   * waiting for — and a forwarding list is precisely what these threads are
   * addressed to. The flag is recorded so the timeline can dim an out-of-office,
   * which is the one thing it is genuinely good for.
   */
  const automation = classifyAutomation(email);

  const rawHtml = email.htmlBody ?? null;
  const strippedHtml = rawHtml ? stripQuotedHtml(rawHtml) : null;
  const strippedText = stripQuotedText(email.textBody ?? '');

  const sanitisedHtml = strippedHtml ? sanitiseEmailHtml(strippedHtml.visible) : null;
  const bodyText = strippedText.visible.trim()
    ? strippedText.visible
    : sanitisedHtml
      ? htmlToText(sanitisedHtml)
      : '';

  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(sideConversationMessages)
      .values({
        sideConversationId: side.id,
        direction: 'inbound',
        // Who actually answered. The thread is addressed to a list, so this is
        // the only place the individual is named.
        fromAddress: email.from.address,
        fromName: email.from.name ?? null,
        toAddresses: email.to.map((a) => a.address),
        ccAddresses: email.cc.map((a) => a.address),
        bodyHtml: sanitisedHtml,
        bodyText,
        rawBody: rawHtml ?? email.textBody ?? null,
        channelMessageId: email.messageId,
        inReplyTo: email.inReplyTo ?? null,
        deliveryStatus: 'delivered',
        deliveredAt: email.receivedAt,
        meta: {
          automationReason: automation.reason,
          isAutomated: automation.isAutomated,
          isBounce: automation.isBounce,
          strippedBy: strippedText.matchedBy ?? strippedHtml?.matchedBy ?? null,
          spfPass: email.spfPass,
          spamScore: email.spamScore,
        },
        createdAt: email.receivedAt,
      })
      .returning({ id: sideConversationMessages.id });

    await tx
      .update(sideConversations)
      .set({
        lastMessageAt: email.receivedAt,
        lastInboundAt: email.receivedAt,
        // An answer that arrives after the agent gave up reopens the thread, for
        // the same reason a customer's reply reopens a resolved ticket: filing it
        // under `done` puts the thing somebody was waiting for behind a collapsed
        // card nobody has a reason to open again. An out-of-office does not count
        // — that is a machine saying nothing, not the hub answering.
        ...(side.state === 'done' && !automation.isAutomated
          ? { state: 'open' as const, closedAt: null, closedByAgentId: null }
          : {}),
      })
      .where(eq(sideConversations.id, side.id));

    // Only this one column on the ticket. See the module docstring.
    await tx
      .update(conversations)
      .set({ lastMessageAt: email.receivedAt })
      .where(eq(conversations.id, side.conversationId));

    // The ticket's activity feed is where an agent who was not the one who asked
    // finds out that an answer arrived at all — an out-of-office is not one, so
    // it is not announced as one.
    if (!automation.isAutomated) {
      await tx.insert(conversationEvents).values({
        conversationId: side.conversationId,
        type: 'side_conversation_replied',
        actorLabel: email.from.name ?? email.from.address,
        data: {
          sideConversationNumber: side.number,
          from: email.from.address,
        },
      });
    }

    return inserted[0]!.id;
  });

  await storeAttachments(side.conversationId, result, email);

  return {
    sideConversationId: side.id,
    sideConversationNumber: side.number,
    conversationId: side.conversationId,
    conversationNumber: side.conversationNumber,
    messageId: result,
    duplicate: false,
  };
}

/**
 * Uploaded after the transaction commits, for the reason the ticket path gives:
 * a slow or failing upload must not roll back the message, which is the part
 * that matters. Hub replies carry photographs — a failed-delivery snap, a photo
 * of the waybill — so this path is used more than its equivalent on email.
 */
async function storeAttachments(
  conversationId: string,
  sideMessageId: string,
  email: ParsedInboundEmail,
): Promise<void> {
  if (email.attachments.length === 0) return;

  for (const [index, attachment] of email.attachments.entries()) {
    try {
      const path = buildAttachmentPath(
        conversationId,
        `side-${sideMessageId}-${index}`,
        attachment.filename,
      );
      const stored = await uploadObject(path, attachment.content, attachment.contentType);

      await db.insert(attachmentsTable).values({
        sideMessageId,
        storagePath: stored.path,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
        contentId: attachment.contentId ?? null,
        isInline: attachment.isInline,
      });
    } catch (error) {
      console.error(
        `[side-ingest] attachment "${attachment.filename}" failed for ${sideMessageId}`,
        error,
      );
    }
  }
}
