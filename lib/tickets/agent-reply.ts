import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, messages } from '@/db/schema';
import { enqueueMessageCreated } from '@/lib/api/notify';
import { enqueue } from '@/lib/queue';
import { runAutomations } from '@/lib/automations';
import { afterHoldEnded } from '@/lib/routing/after-hold';
import { endHold } from '@/lib/routing/end-hold';
import { onAgentReply } from '@/lib/sla';
import { afterMessageStored } from '@/lib/tickets/lifecycle';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import { carrierFor, rowIsDelivery } from '@/lib/tickets/outbound';

/** The row an agent's reply is stored as, less what every reply shares. */
export type AgentReplyMessage = Omit<
  typeof messages.$inferInsert,
  'conversationId' | 'direction' | 'kind'
> & { authorAgentId: string; bodyText: string };

/**
 * What happens once an agent's reply is written, for both console senders: a
 * free-text reply and a WhatsApp template.
 *
 * Kept apart from `deliverAutomatedReply` in `outbound.ts` on purpose. This is
 * the path that moves `lastAgentMessageAt` and stops the SLA clocks for a reply
 * written in the console, and the `automated-reply-boundary` check forbids the
 * first in `outbound.ts`: an acknowledgement written by software must leave the
 * ticket in the unanswered queue. (The two other paths are a person too: a
 * reply the business typed on the WhatsApp Business app of a number connected
 * through coexistence, which `ingestWhatsAppEcho` counts the same way, and one
 * typed in Meta Business Suite on a Messenger thread, which `ingestMetaEcho`
 * does.) What each sender checks before it gets here — permission, read-only
 * channels, the messaging windows, the template's account — stays in its action.
 *
 * Returns the new message's id.
 */
export async function storeAgentReply(
  conversationId: string,
  channel: ConversationChannel,
  message: AgentReplyMessage,
): Promise<string> {
  const inserted = await db
    .insert(messages)
    .values({ ...message, conversationId, direction: 'outbound', kind: 'reply' })
    .returning({ id: messages.id });

  const messageId = inserted[0]!.id;

  // A person answering a ticket held for the router has decided for it: the
  // hold ends with the reply, in its transaction (`endHold`). Not once the
  // router has written its decision (phase one): that decision is the
  // router's to finish, and the reply ends nothing.
  const endedHold = await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({ lastMessageAt: new Date(), lastAgentMessageAt: new Date() })
      .where(eq(conversations.id, conversationId));
    return endHold(tx, conversationId, 'manual', {
      agentId: message.authorAgentId,
      decidesShadow: false,
    });
  });

  // The clock stops when the agent writes, not when the provider accepts the
  // message: the delay is ours to own, and a send that fails is visible on the
  // timeline anyway.
  await onAgentReply(conversationId);

  // What the hold kept back: the assignment, and an out-of-hours reply that
  // the agent's answer has made moot, which its guard then skips. Owed here
  // only when the reply ended the hold; on a decision in flight the router's
  // own end of it pays both, after the category's rules, so the assignment
  // lands in whichever group they leave the ticket.
  //
  // And, first, the `on_update` pass a category Jev wrote while the ticket was
  // held handed to the router, which this reply has now decided for: a reply
  // runs no pass of its own, where the console's edits and Hand to each run
  // one after their end of the hold, so without this a rule keyed on that
  // category never ran on the ticket (`categoryOwed`). Best-effort, as all of
  // it is: the reply is stored, and its send below must be queued whatever
  // these reads meet.
  if (endedHold) {
    await afterHoldEnded(conversationId, new Date(), {
      runOwedPass: () => runAutomations('on_update', conversationId),
    });
  }

  // Web chat and the myBlu app have no outbound provider: writing the row *is*
  // delivery, because the customer's client — the widget's open stream, the
  // app's poll — reads the same table (`rowIsDelivery`).
  if (!rowIsDelivery(channel)) {
    await enqueue(
      carrierFor(channel),
      { messageId },
      // dedupeKey on the message id: a double-submit or a retried action can
      // never queue the same reply twice.
      { priority: 10, dedupeKey: `send:${messageId}` },
    );
  }

  // On the myBlu app, the push that tells the user's phone the reply is
  // there: myBlu's backend is told, and pushes. Nothing on any other channel,
  // and nothing while the webhook is off. Best-effort: the reply above is
  // already the delivery, and a push that cannot be queued is logged, never
  // answered to the agent as a reply that failed.
  await enqueueMessageCreated(channel, messageId, { priority: 10 });

  // An agent looks a parcel up on the shipping platform and pastes the number
  // into their answer, which is why this runs on outbound as well as inbound.
  await afterMessageStored({
    conversationId,
    messageId,
    bodyText: message.bodyText,
    kind: 'reply',
    direction: 'outbound',
  });

  return messageId;
}
