'use server';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contactIdentities, conversationEvents, messages } from '@/db/schema';
import { requireAgent } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { can } from '@/lib/auth/permissions';
import { enqueue } from '@/lib/queue';
import {
  moderatableComment,
  type ModerationAction,
  moderationRefusal,
  readCommentModeration,
  requested as requestModeration,
} from '@/lib/meta/moderation';
import { describeProfileRefresh, refreshChannelProfile } from '@/lib/meta/profile-refresh';
import { MetaApiError, takeThreadControl } from '@/lib/meta/client';
import { explainTakeControlError } from '@/lib/meta/errors';
import { metaReplyTarget, THREAD_CONTROL_TAKEN } from '@/lib/tickets/meta-thread';
import { loadConversation, refresh, refuseIfReadOnly } from '@/lib/tickets/console-guards';
import type { ActionState } from './action-state';

/**
 * Hides, unhides or deletes a customer's public comment.
 *
 * The other half of a social ticket. Replying is the answer to a question;
 * this is the answer to abuse, to a leaked phone number in a public thread, and
 * to the comment somebody posts forty times. It is the `manage` in
 * `instagram_business_manage_comments`, and until now the console could do
 * neither verb — `hideComment` sat unimported in `lib/meta/client.ts` and there
 * was no delete at all.
 *
 * The comment is re-read from the database rather than taken from the form. A
 * `FormData` field naming a comment id would be an endpoint for hiding any
 * comment on any of our posts, whatever ticket the agent could see.
 */
export async function moderateComment(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.moderate_comment')) {
    return { error: 'You do not have permission to hide or delete comments' };
  }

  const messageId = String(formData.get('messageId') ?? '');
  const wanted = String(formData.get('action') ?? '');

  if (wanted !== 'hide' && wanted !== 'unhide' && wanted !== 'delete') {
    return { error: 'Unknown moderation action' };
  }
  const action: ModerationAction = wanted;

  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId, meta: messages.meta })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  const message = rows[0];
  if (!message) return { error: 'Comment not found' };

  // The ticket comes from the message, so the agent's visibility rule is applied
  // to the conversation that actually owns the comment.
  const row = await loadConversation(agent, message.conversationId);
  if (!row) return { error: 'Ticket not found' };

  const readOnly = refuseIfReadOnly(row.conversation.channel);
  if (readOnly) return readOnly;

  const comment = moderatableComment(message.meta);
  if (!comment) return { error: 'That message is not a Facebook or Instagram comment' };

  const state = readCommentModeration(message.meta);
  const refusal = moderationRefusal(state, action);
  if (refusal) return { error: refusal };

  const base = (message.meta ?? {}) as Record<string, unknown>;

  // Pending, not done: what the public can see has not changed until Graph says
  // so, and the timeline claiming otherwise is the one thing an agent moderating
  // a comment must not be told.
  await db
    .update(messages)
    .set({
      meta: {
        ...base,
        moderation: requestModeration(state, action, agent.id, new Date()),
      },
    })
    .where(eq(messages.id, message.id));

  // No dedupeKey: hide and unhide are each other's opposite and both are
  // legitimately repeatable, and a key is spent for good rather than until the
  // job finishes (see EnqueueOptions). `moderationRefusal` above is the guard
  // against a double submit instead.
  await enqueue(
    'moderate_meta_comment',
    { messageId: message.id, action, agentId: agent.id },
    { priority: 10 },
  );

  refresh(row.conversation.number);
  return ok();
}

/**
 * Asks Meta again who this customer is, because an agent said so.
 *
 * Every other profile lookup in the system is a job, and this one is not. The
 * rule those follow — anything slow, external or retryable is queued — exists so
 * that filing a customer's ticket never depends on Graph being up, and so that
 * unattended work can be retried. Neither applies to a person pressing a button
 * and waiting: the queue's retries are what the agent's second click already is,
 * and the *whole output of this action is Meta's answer*, which a job would
 * write to a worker log the agent cannot read. That log is precisely where the
 * last month's diagnosis went to die (§6.27), so putting it back there would be
 * repeating the mistake this button exists to end.
 *
 * The Graph call itself is `refreshChannelProfile`, shared with the job, so the
 * two paths cannot answer differently for the same customer.
 */
export async function refreshRequesterProfile(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.edit')) {
    return { error: 'You do not have permission to edit contacts' };
  }

  const row = await loadConversation(agent, String(formData.get('conversationId') ?? ''));
  if (!row) return { error: 'Ticket not found' };

  const readOnly = refuseIfReadOnly(row.conversation.channel);
  if (readOnly) return readOnly;

  const channel = row.conversation.channel;
  if (channel !== 'facebook' && channel !== 'instagram') {
    return { error: 'Only Facebook and Instagram customers have a profile to look up' };
  }

  // The identity is re-read here rather than posted by the form: a scoped id in
  // a FormData field is an argument to a Graph call, and the ticket is the only
  // thing entitled to say which customer this is.
  const identities = await db
    .select({ identifier: contactIdentities.identifier })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.contactId, row.conversation.requesterContactId),
        eq(contactIdentities.channel, channel),
      ),
    )
    .limit(1);

  const identity = identities[0];
  if (!identity) return { error: 'This customer has no ' + channel + ' identity on file' };

  const result = await refreshChannelProfile({
    contactId: row.conversation.requesterContactId,
    platform: channel,
    userId: identity.identifier,
    // The point of the button. Without it a contact already answered for — with
    // a name Meta has since changed, or a picture that failed to copy — would
    // return "already looked up" and the agent would have no way to force it.
    force: true,
  });

  // Recorded for the outcomes that say something durable about this ticket. A
  // refusal is worth as much as a success here: it is the evidence that the app
  // asked and was turned down, on a date, at somebody's request.
  if (result.kind === 'applied' || result.kind === 'refused') {
    await db.insert(conversationEvents).values({
      conversationId: row.conversation.id,
      type: result.kind === 'applied' ? 'profile_refreshed' : 'profile_refresh_refused',
      actorAgentId: agent.id,
      data:
        result.kind === 'applied'
          ? { name: result.name, picture: result.picture }
          : { permission: result.permission },
    });
  }

  refresh(row.conversation.number);

  const described = describeProfileRefresh(result);
  return result.kind === 'applied' || result.kind === 'skipped'
    ? { ...ok(), message: described }
    : { error: described };
}

/**
 * Takes thread control of a Messenger or Instagram conversation another app owns.
 *
 * The second control in this codebase to call a provider from an action rather
 * than through the queue, and it qualifies under the same narrow exception
 * `refreshRequesterProfile` documents above: an agent presses it and *waits*,
 * and the entire output is Meta's answer. Queueing it would put the one sentence
 * they need — very often "this app is not the primary receiver", which no retry
 * will change — into a worker log they cannot read.
 *
 * It is also the answer to a refusal this console could previously only
 * describe. A ticket arriving in the handover protocol's `standby` array is
 * readable and unanswerable, and every remedy `lib/meta/thread.ts` could offer
 * was in somebody else's software. This is the one the protocol actually exposes.
 *
 * Gated on `ticket.reply` rather than a key of its own. Taking control is not a
 * separate capability an agent might be trusted with independently — it is the
 * precondition for replying on this channel, it is undone by the other tool
 * taking the thread back, and it changes nothing a customer can see. A key
 * nobody would ever grant apart from `ticket.reply` is a key that only makes
 * the permission screen longer.
 */
export async function claimThreadControl(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.reply')) {
    return { error: 'You do not have permission to reply to tickets' };
  }

  const row = await loadConversation(agent, String(formData.get('conversationId') ?? ''));
  if (!row) return { error: 'Ticket not found' };

  const readOnly = refuseIfReadOnly(row.conversation.channel);
  if (readOnly) return readOnly;

  const channel = row.conversation.channel;
  if (channel !== 'facebook' && channel !== 'instagram') {
    return { error: 'Only Facebook and Instagram conversations have thread control' };
  }

  // The recipient and the verdict both come from here rather than from the
  // form: a page-scoped id in a FormData field is an argument to a Graph call,
  // and re-reading is also what makes the check below describe the ticket as it
  // is now rather than as the page rendered it.
  const { recipientId, thread } = await metaReplyTarget(row.conversation.id, channel);

  if (thread.reason !== 'standby') {
    // Includes the case the button exists for having already succeeded. Saying
    // so is better than taking control of a thread we hold: the call would
    // succeed and the agent would learn nothing about why the composer was
    // shut.
    return {
      error: thread.canSend
        ? 'This ticket is already answerable from here — reload the page.'
        : (thread.explanation ??
          'This ticket cannot be answered from here, and not because of thread control.'),
    };
  }

  if (!recipientId) {
    return { error: 'This ticket has no inbound message, so there is no thread to take.' };
  }

  try {
    await takeThreadControl({ platform: channel, recipientId });
  } catch (error) {
    if (error instanceof MetaApiError) return { error: explainTakeControlError(error, channel) };
    throw error;
  }

  /*
    The event is what actually reopens the composer, and it has to be written
    for that to happen.

    `standby` on the customer's last message is a permanent fact about that
    message, so nothing here rewrites it — `metaThreadStateFromMessage` compares
    the two timestamps instead and takes the newer. Which means a successful
    Graph call whose event failed to insert would leave the ticket looking
    exactly as refused as before, and this is the ordering that makes that the
    only failure mode rather than the reverse.
  */
  await db.insert(conversationEvents).values({
    conversationId: row.conversation.id,
    type: THREAD_CONTROL_TAKEN,
    actorAgentId: agent.id,
  });

  refresh(row.conversation.number);

  // No message: `ThreadControl` is replaced by the reply box when the re-read
  // page arrives with this answer, so a sentence here was never painted (its
  // docblock).
  return ok();
}
