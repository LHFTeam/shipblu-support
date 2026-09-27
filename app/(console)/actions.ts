'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import {
  agents,
  cannedResponses,
  contactIdentities,
  contacts,
  conversationCategories,
  conversationEvents,
  conversationShipments,
  conversations,
  internalRecipients,
  locations,
  messages,
  shipments,
  sideConversationMessages,
  sideConversations,
  ticketCategories,
  ticketRootCauses,
  groups,
  ticketStatuses,
  whatsappTemplates,
} from '@/db/schema';
import { purgeConversation, type PurgeRefusal } from '@/lib/admin/purge';
import { hiddenScopeRefusal } from '@/lib/admin/purge-visibility';
import { assignConversation } from '@/lib/assignment';
import { refreshPrimary } from '@/lib/categorise/apply';
import { CAUSE_REQUIRED_AREAS } from '@/lib/categorise/taxonomy';
import { requestAssignmentSweep, setAccepting } from '@/lib/assignment/presence';
import { requireAgent, requirePermission } from '@/lib/auth/guard';
import { text } from '@/lib/http/form-data';
import { ok, type ActionState as BaseActionState } from '@/lib/http/action-state';
import { isUuid } from '@/lib/http/uuid';
import { env } from '@/lib/env';
import { can } from '@/lib/auth/permissions';
import { canSeeChannel, readOnlyReason } from '@/lib/tickets/channel-policy';
import { carrierFor, sendsByEmail } from '@/lib/tickets/outbound';
import { isPriority } from '@/lib/tickets/vocabulary';
import type { SessionAgent } from '@/lib/auth/session';
import { htmlToText, sanitiseEmailHtml, textToHtml } from '@/lib/html/sanitize';
import { enqueue } from '@/lib/queue';
import { onAgentReply, onGroupChanged, onStatusChanged } from '@/lib/sla';
import {
  afterMessageStored,
  afterTicketResolved,
  afterTicketUpdate,
} from '@/lib/tickets/lifecycle';
import {
  buildTemplateComponents,
  renderTemplatePreview,
  templateShape,
  TemplateParameterError,
} from '@/lib/whatsapp/templates';
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
import { metaWindowState } from '@/lib/meta/window';
import { metaReplyTarget, THREAD_CONTROL_TAKEN } from '@/lib/tickets/meta-thread';
import {
  attachShipment,
  attachShippingAccount,
  detachShipment,
  detachShippingAccount,
  upsertShipmentStub,
  upsertShippingAccountStub,
} from '@/lib/shipments/links';
import { normaliseSbid, normaliseTrackingNumber } from '@/lib/shipments/format';
import { syncShipment } from '@/lib/shipments/sync';
import { quoteAnchor } from '@/lib/side-conversations/format';
import {
  normaliseAddress,
  parseAddressList,
  refuseRecipient,
  refuseRecipients,
} from '@/lib/side-conversations/guard';
import { lastSideMessageId, loadSideConversation } from '@/lib/side-conversations/queries';
import { isBlank, listLabels, missingRequired } from '@/lib/tickets/custom-fields';
import { parseFieldValue } from '@/lib/tickets/custom-fields-parse';
import { getTicketField, listTicketFields } from '@/lib/tickets/lookups';
import { accountIdForConversation } from '@/lib/whatsapp/conversation';
import { windowState } from '@/lib/whatsapp/window';

/**
 * Console write actions.
 *
 * All of them follow the same shape: authorise, write the row, record an audit
 * event, and enqueue any outbound work. Delivery never happens inline — the
 * agent's reply is saved and visible before a provider is contacted, so an
 * outage delays the send instead of losing what they wrote.
 */

export type ActionState = BaseActionState & {
  /**
   * What happened, when succeeding quietly would leave the agent guessing.
   * Most actions change something visible on the page and need none; a profile
   * refresh whose whole output is Meta's answer needs one.
   */
  message?: string;
};

async function loadConversation(agent: SessionAgent, conversationId: string) {
  // Every action on a ticket starts here with an id out of a form field. A
  // malformed one is a ticket that does not exist, not a 22P02 thrown out of
  // the action — which returns no state, so the agent saw a blank failure.
  if (!isUuid(conversationId)) return null;

  const rows = await db
    .select({
      conversation: conversations,
      statusCategory: ticketStatuses.category,
      requesterEmail: contacts.primaryEmail,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Same visibility rule as the read path, re-checked here: an action is a
  // separate entry point and must not trust that the page filtered anything.
  if (!can(agent, 'ticket.view.all') && row.conversation.assigneeAgentId !== agent.id) {
    return null;
  }

  if (!canSeeChannel(agent, row.conversation.channel)) return null;

  return row;
}

/**
 * Refuses a write to a channel the platform only observes.
 *
 * Checked in the actions rather than only in the composer: hiding the textarea
 * stops the honest path, and this stops the other ones — a stale tab open from
 * before the channel existed, a resubmitted form, a hand-made POST.
 */
function refuseIfReadOnly(channel: string): ActionState | null {
  const reason = readOnlyReason(channel);
  return reason ? { error: reason } : null;
}

function refresh(number: number) {
  revalidatePath(`/inbox/${number}`);
  revalidatePath('/inbox');
  // The category review queue is a view onto these tickets' categories, so any
  // ticket write can stale it. Here rather than in each action, for the reason
  // channel-policy.ts gives about rules spread across call sites.
  revalidatePath('/admin/categories/review');
}

/**
 * Refuses to resolve a ticket whose required fields are still empty.
 *
 * `required_on_resolve` was written by the admin form and read by nothing since
 * the first migration, so a field marked required could be left empty
 * everywhere. This is the gate that makes the flag mean something.
 *
 * Deliberately only on the agent's own path. An automation or an SLA escalation
 * that resolves a ticket is not stopped by it: a rule cannot fill a field in, so
 * enforcing it there would leave tickets wedged in a state no human was asked to
 * clear, and the flag is about what a person must record before calling it done.
 */
async function refuseIfIncomplete(
  customFields: Record<string, unknown>,
): Promise<ActionState | null> {
  const missing = missingRequired(await listTicketFields(), customFields, 'resolve');
  if (!missing.length) return null;

  return {
    error: `Fill in ${listLabels(missing)} before resolving this ticket`,
  };
}

/**
 * Refuses to resolve a ticket that went wrong without saying why.
 *
 * The root cause is the dimension the business acts on — a category report says
 * what the queue is full of, and only this says what to go and fix — and it
 * cannot be detected, because the customer does not know it. Which means the
 * only moment it can be captured is the one where somebody has just finished
 * looking into the ticket.
 *
 * Only for the areas where something actually failed. A price-list question or
 * an integration walkthrough has no cause, and demanding one would teach agents
 * to pick whatever clears the dialogue — which is how a dimension fills up with
 * noise and stops being worth reporting on.
 *
 * On the agent's own path only, exactly as `refuseIfIncomplete` is: an
 * automation cannot know why a parcel was late, so enforcing this against the
 * three-day auto-close would wedge tickets in a state no person was asked to
 * clear.
 *
 * The list of areas lives in `lib/categorise/taxonomy.ts` because the coverage
 * figure on the report has to measure the same population this gate demands —
 * two definitions of "owes a cause" is how a report comes to say 40% of tickets
 * are missing something that was never asked of most of them.
 */
async function refuseIfNoRootCause(conversationId: string): Promise<ActionState | null> {
  const rows = await db
    .select({
      rootCauseId: conversations.rootCauseId,
      area: ticketCategories.area,
    })
    .from(conversations)
    .leftJoin(
      conversationCategories,
      and(
        eq(conversationCategories.conversationId, conversations.id),
        eq(conversationCategories.isPrimary, true),
      ),
    )
    .leftJoin(ticketCategories, eq(ticketCategories.id, conversationCategories.categoryId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.rootCauseId) return null;
  if (!row.area || !CAUSE_REQUIRED_AREAS.includes(row.area)) return null;

  return { error: 'Record what caused this before closing it' };
}

// --- Replies and notes ------------------------------------------------------

export async function sendReply(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.reply')) return { error: 'You do not have permission to reply' };

  const conversationId = String(formData.get('conversationId') ?? '');
  const body = text(formData, 'body');
  const resolveAfter = formData.get('resolveAfter') === 'on';
  const cannedResponseId = String(formData.get('cannedResponseId') ?? '');

  if (!body) return { error: 'Write something first' };

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const conversation = row.conversation;

  const readOnly = refuseIfReadOnly(conversation.channel);
  if (readOnly) return readOnly;

  // Checked before the reply is written rather than beside the resolve below it.
  // Refusing afterwards would send the message, leave the ticket open and clear
  // the composer, so the agent would see a reply they cannot un-send and a
  // status that did not move, with nothing on screen saying why.
  if (resolveAfter) {
    // Checked in order, and the second query only runs if the first passed.
    // Computing both and then reporting the *newer* one first put a message
    // about the root cause in front of a required-fields message that predates
    // this feature — so an agent filled in a cause, pressed the button again,
    // and only then learned about the two empty fields.
    const incomplete = await refuseIfIncomplete(conversation.customFields);
    if (incomplete) return incomplete;
    const uncaused = await refuseIfNoRootCause(conversationId);
    if (uncaused) return uncaused;
  }

  if (conversation.channel === 'whatsapp') {
    // Checked before the row is written, so an agent is told the window closed
    // instead of watching their reply fail asynchronously a second later.
    const state = windowState(conversation.lastCustomerMessageAt);
    if (!state.isOpen) {
      return {
        error:
          'The 24-hour WhatsApp window has closed. Send an approved template to reopen the conversation.',
      };
    }
  }

  const isMeta = conversation.channel === 'facebook' || conversation.channel === 'instagram';
  const isCommentThread = Boolean(conversation.externalId?.includes(':comment:'));

  // A comment ticket can be answered in public, or taken private exactly once.
  // A direct-message ticket only has the one option.
  const requestedSendKind = String(formData.get('metaSendKind') ?? '');
  const metaSendKind: 'dm' | 'comment_reply' | 'private_reply' = !isCommentThread
    ? 'dm'
    : requestedSendKind === 'private_reply'
      ? 'private_reply'
      : 'comment_reply';

  if (isMeta && metaSendKind === 'dm') {
    // Whether the thread can be answered at all comes before how long is left
    // to answer it — a reply into an inbox another app controls, or onto a page
    // this deployment cannot address, fails whatever the clock says, and it
    // fails with a Graph error that names no reason.
    const { thread } = await metaReplyTarget(
      conversationId,
      conversation.channel as 'facebook' | 'instagram',
    );
    if (!thread.canSend) return { error: thread.explanation ?? 'This thread cannot be answered.' };

    const state = metaWindowState(conversation.lastCustomerMessageAt);
    if (state.isClosed) {
      return {
        error:
          state.reason === 'never_opened'
            ? 'This customer has never messaged us, so there is no thread to reply in.'
            : 'The 7-day messaging window has closed. Only the customer can reopen this conversation.',
      };
    }
  }

  // A portal ticket's reply goes out by email too, so it is written as one.
  const isEmail = sendsByEmail(conversation.channel);
  const isWebchat = conversation.channel === 'webchat';
  const html = isEmail ? sanitiseEmailHtml(textToHtml(body)) : null;

  const parentMessageId = await lastInboundChannelMessageId(conversationId);

  const inserted = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'outbound',
      kind: 'reply',
      authorAgentId: agent.id,
      bodyText: isEmail && html ? htmlToText(html) : body,
      bodyHtml: html,
      toAddresses: isEmail && row.requesterEmail ? [row.requesterEmail] : [],
      inReplyTo: parentMessageId,
      // Web chat has no outbound provider: writing the row *is* delivery,
      // because the visitor's open stream reads the same table. Marking it
      // pending would leave a permanent "sending…" badge on a message the
      // customer is already looking at.
      deliveryStatus: isWebchat ? 'delivered' : 'pending',
      ...(isWebchat ? { deliveredAt: new Date() } : {}),
      meta:
        conversation.channel === 'whatsapp'
          ? { sendKind: 'text' }
          : isMeta
            ? {
                metaKind: isCommentThread ? 'comment' : 'direct_message',
                platform: conversation.channel,
                sendKind: metaSendKind,
                // A public reply is on the record for everyone who can see the
                // post, so the timeline says which of the two this was.
                isPublic: metaSendKind === 'comment_reply',
              }
            : {},
    })
    .returning({ id: messages.id });

  const messageId = inserted[0]!.id;

  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), lastAgentMessageAt: new Date() })
    .where(eq(conversations.id, conversationId));

  // The clock stops when the agent writes, not when the provider accepts the
  // message: the delay is ours to own, and a send that fails is visible on the
  // timeline anyway.
  await onAgentReply(conversationId);

  if (!isWebchat) {
    await enqueue(
      carrierFor(conversation.channel),
      { messageId },
      // dedupeKey on the message id: a double-submit or a retried action can
      // never queue the same reply twice.
      { priority: 10, dedupeKey: `send:${messageId}` },
    );
  }

  // An agent looks a parcel up on the shipping platform and pastes the number
  // into their answer, which is why this runs on outbound as well as inbound.
  await afterMessageStored({
    conversationId,
    messageId,
    bodyText: isEmail && html ? htmlToText(html) : body,
    kind: 'reply',
    direction: 'outbound',
  });

  if (cannedResponseId) await countCannedUse(cannedResponseId);

  if (resolveAfter) {
    await applyStatusCategory(agent, conversation.id, 'resolved');
  }

  refresh(conversation.number);
  return ok();
}

/**
 * Records that a canned response went out in a reply.
 *
 * After the send rather than before it: the column ranks what the team actually
 * sends, so a reply that failed validation and never left must not count. The
 * id comes from the composer, so it is incremented rather than trusted for
 * anything — a bogus id updates no rows, which is the whole blast radius.
 *
 * Not awaited for correctness anywhere: a lost increment costs a ranking column
 * one point, and failing the agent's reply because a counter did not move would
 * be the wrong trade.
 */
async function countCannedUse(id: string): Promise<void> {
  try {
    await db
      .update(cannedResponses)
      .set({ usageCount: sql`${cannedResponses.usageCount} + 1` })
      .where(eq(cannedResponses.id, id));
  } catch (error) {
    console.warn('[canned] could not record a use', error);
  }
}

export async function addNote(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.note')) return { error: 'You do not have permission to add notes' };

  const conversationId = String(formData.get('conversationId') ?? '');
  const body = text(formData, 'body');
  if (!body) return { error: 'Write something first' };

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  // A note is internal and never reaches the customer, so this is the one
  // refusal here that is not about protecting them. It is about the channel
  // being a record of somebody else's conversation: an observed transcript that
  // accumulates our commentary stops being a faithful copy of what happened.
  const readOnly = refuseIfReadOnly(row.conversation.channel);
  if (readOnly) return readOnly;

  const note = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'outbound',
      kind: 'note',
      authorAgentId: agent.id,
      bodyText: body,
      // Notes are internal, so they are never queued for delivery. Marking them
      // delivered keeps the timeline from showing a permanent "pending" badge.
      deliveryStatus: 'delivered',
    })
    .returning({ id: messages.id });

  // Notes are where an agent writes down what they found on the shipping
  // platform, so they carry tracking numbers at least as often as replies do.
  await afterMessageStored({
    conversationId,
    messageId: note[0]!.id,
    bodyText: body,
    kind: 'note',
    direction: 'outbound',
  });

  refresh(row.conversation.number);
  return ok();
}

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

  return {
    ...ok(),
    message:
      'Thread control taken — you can reply now. The other tool has been told, and it can ' +
      'take the thread back at any time.',
  };
}

/**
 * Sends an approved template — the only thing that can reach a customer once
 * the 24-hour window has closed.
 */
export async function sendTemplateReply(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.reply')) return { error: 'You do not have permission to reply' };

  const conversationId = String(formData.get('conversationId') ?? '');
  const templateId = String(formData.get('templateId') ?? '');

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  // Before the channel check below, so the bot channel is refused for the real
  // reason rather than told that templates are WhatsApp only — which, on a
  // WhatsApp number, would read as a bug.
  const readOnly = refuseIfReadOnly(row.conversation.channel);
  if (readOnly) return readOnly;

  if (row.conversation.channel !== 'whatsapp') return { error: 'Templates are WhatsApp only' };

  const [templates, accountId] = await Promise.all([
    db.select().from(whatsappTemplates).where(eq(whatsappTemplates.id, templateId)).limit(1),
    accountIdForConversation(row.conversation.id),
  ]);

  const template = templates[0];
  if (!template) return { error: 'Template not found' };
  if (template.status !== 'APPROVED') {
    return { error: `Template "${template.name}" is ${template.status.toLowerCase()} in Meta` };
  }

  // The picker already scopes to this ticket's business account; this is the
  // server-side half of it, because the template id arrives in a FormData
  // field. A template approved on another WABA is accepted by the send API and
  // then rejected on a status webhook, so refusing it here is the only place
  // the agent finds out at all.
  if (template.whatsappAccountId !== accountId) {
    return {
      error: `Template "${template.name}" belongs to a different WhatsApp business account than this ticket's number.`,
    };
  }

  const shape = templateShape(template.components);

  // Form fields are named body_1, body_2… matching Meta's {{1}} numbering.
  const bodyValues = Array.from({ length: shape.bodyVariableCount }, (_, index) =>
    String(formData.get(`body_${index + 1}`) ?? '').trim(),
  );
  const headerValues = Array.from({ length: shape.headerVariableCount }, (_, index) =>
    String(formData.get(`header_${index + 1}`) ?? '').trim(),
  );

  let components;
  try {
    components = buildTemplateComponents({ shape, bodyValues, headerValues });
  } catch (error) {
    if (error instanceof TemplateParameterError) return { error: error.message };
    throw error;
  }

  // The rendered text is what the timeline shows. Without it the agent's own
  // record of the conversation reads "template shipment_update", which is
  // useless when someone asks what we actually told the customer.
  const rendered = renderTemplatePreview(shape.bodyText, bodyValues);

  const inserted = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'outbound',
      kind: 'reply',
      authorAgentId: agent.id,
      bodyText: rendered,
      deliveryStatus: 'pending',
      meta: {
        sendKind: 'template',
        template: { name: template.name, language: template.language, components },
        templateName: template.name,
      },
    })
    .returning({ id: messages.id });

  const messageId = inserted[0]!.id;

  await db
    .update(conversations)
    .set({ lastMessageAt: new Date(), lastAgentMessageAt: new Date() })
    .where(eq(conversations.id, conversationId));

  await onAgentReply(conversationId);

  await enqueue('send_whatsapp', { messageId }, { priority: 10, dedupeKey: `send:${messageId}` });

  // The most predictable source of a tracking number in the whole system: the
  // shipment_update template's body is "Hi {{1}}, your shipment {{2}} is out
  // for delivery today", and {{2}} is filled in above.
  await afterMessageStored({
    conversationId,
    messageId,
    bodyText: rendered,
    kind: 'reply',
    direction: 'outbound',
  });

  refresh(row.conversation.number);
  return ok();
}

// --- Ticket properties ------------------------------------------------------

export async function updateTicket(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();

  const conversationId = String(formData.get('conversationId') ?? '');
  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const field = String(formData.get('field') ?? '');
  const value = String(formData.get('value') ?? '');

  switch (field) {
    case 'status': {
      if (!isUuid(value)) return { error: 'Unknown status' };
      const statuses = await db
        .select({
          id: ticketStatuses.id,
          name: ticketStatuses.name,
          category: ticketStatuses.category,
          stopsSlaClock: ticketStatuses.stopsSlaClock,
        })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.id, value))
        .limit(1);

      const status = statuses[0];
      if (!status) return { error: 'Unknown status' };

      // Checked here rather than only by hiding the option, because the option
      // arrives back as a FormData string and the picker is not the authority
      // on what an agent may send.
      if (status.category === 'closed' && !can(agent, 'ticket.close')) {
        return { error: 'Only a supervisor can close a ticket — resolve it instead' };
      }

      // Both terminal categories, not just `resolved`. `Closed` is a seeded
      // status an agent can pick from the same dropdown, and gating only the
      // one next to it made the whole rule advisory: picking the other option
      // ended the ticket with no cause recorded and nothing to say so. See
      // `conversations.root_cause_set_at` for how a closed ticket's cause is
      // then dated, since `resolved_at` stays null on this path.
      if (status.category === 'resolved' || status.category === 'closed') {
        const incomplete = await refuseIfIncomplete(row.conversation.customFields);
        if (incomplete) return incomplete;
        const uncaused = await refuseIfNoRootCause(conversationId);
        if (uncaused) return uncaused;
      }

      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({
            statusId: status.id,
            resolvedAt: status.category === 'resolved' ? new Date() : null,
            // Stamped on the way in and left alone otherwise. Moving a ticket
            // back to Open must not erase who resolved it — that record is what
            // the reopening about to follow gets attributed to.
            ...(status.category === 'resolved' ? { resolvedByAgentId: agent.id } : {}),
            closedAt: status.category === 'closed' ? new Date() : null,
          })
          .where(eq(conversations.id, conversationId));

        await tx.insert(conversationEvents).values({
          conversationId,
          type: 'status_changed',
          actorAgentId: agent.id,
          data: { to: status.name, category: status.category },
        });
      });

      await onStatusChanged(conversationId, status.stopsSlaClock);
      if (status.category === 'resolved') await afterTicketResolved(conversationId);
      break;
    }

    case 'assignee': {
      if (!can(agent, 'ticket.assign')) return { error: 'You cannot reassign tickets' };
      const assigneeAgentId = value || null;

      // The picker lists active agents only, but the id comes back as a form
      // field and the picker is not the authority. The foreign key would prove
      // the agent exists; it would not stop a ticket being handed to somebody
      // who has left, where nobody will ever answer it.
      if (assigneeAgentId) {
        if (!isUuid(assigneeAgentId)) return { error: 'Unknown agent' };
        const [assignee] = await db
          .select({ isActive: agents.isActive })
          .from(agents)
          .where(eq(agents.id, assigneeAgentId))
          .limit(1);
        if (!assignee) return { error: 'Unknown agent' };
        if (!assignee.isActive) return { error: 'That agent is deactivated' };
      }

      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ assigneeAgentId, assignedAt: assigneeAgentId ? new Date() : null })
          .where(eq(conversations.id, conversationId));

        await tx.insert(conversationEvents).values({
          conversationId,
          type: assigneeAgentId ? 'assigned' : 'unassigned',
          actorAgentId: agent.id,
          data: { to: assigneeAgentId },
        });
      });
      break;
    }

    case 'group': {
      const groupId = value || null;

      // Re-read rather than left to the foreign key, whose violation is a throw
      // and so a blank failure in the console instead of a sentence.
      if (groupId) {
        if (!isUuid(groupId)) return { error: 'Unknown group' };
        const [group] = await db
          .select({ id: groups.id })
          .from(groups)
          .where(eq(groups.id, groupId))
          .limit(1);
        if (!group) return { error: 'Unknown group' };
      }

      await db.transaction(async (tx) => {
        await tx.update(conversations).set({ groupId }).where(eq(conversations.id, conversationId));

        // Recorded, where it was not before. Moving a ticket between teams is
        // the same weight of decision as reassigning it and the case above has
        // always written an event; without this one the timeline could say who
        // took a ticket but never how it reached their team.
        await tx.insert(conversationEvents).values({
          conversationId,
          type: 'group_changed',
          actorAgentId: agent.id,
          data: { to: groupId },
        });
      });

      // Groups can keep their own operating days and holidays, so the due dates
      // are re-counted on the new team's calendar rather than left pointing at
      // hours that team does not work.
      await onGroupChanged(conversationId);

      // The new team may route automatically where the old one did not. A no-op
      // if somebody already holds the ticket, which is the usual case.
      await assignConversation(conversationId, { actorLabel: 'auto_assign' });
      break;
    }

    case 'priority': {
      if (!isPriority(value)) return { error: 'Unknown priority' };

      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ priority: value })
          .where(eq(conversations.id, conversationId));

        await tx.insert(conversationEvents).values({
          conversationId,
          type: 'priority_changed',
          actorAgentId: agent.id,
          data: { to: value },
        });
      });
      break;
    }

    case 'tags': {
      // Split, trim, de-duplicate, drop blanks — the field is free text and
      // "urgent, urgent , " should not become three tags.
      const tags = [
        ...new Set(
          value
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ];

      await db.update(conversations).set({ tags }).where(eq(conversations.id, conversationId));
      break;
    }

    default: {
      // `custom:<key>` — one of the admin-defined ticket fields.
      //
      // The definition is re-read from the database rather than taken from the
      // form: the type decides how the value is parsed and the options decide
      // what is accepted, so a request that could supply either could store an
      // arbitrary value under an arbitrary key and every rule reading it would
      // believe it.
      if (!field.startsWith('custom:')) return { error: `Unknown field "${field}"` };

      if (!can(agent, 'ticket.edit_fields')) {
        return { error: "You cannot edit this ticket's fields" };
      }

      const def = await getTicketField(field.slice('custom:'.length));
      if (!def) return { error: 'Unknown field' };

      const raw = def.type === 'multi_select' ? formData.getAll('value').map(String) : value;
      const parsed = parseFieldValue(def, raw);
      if (!parsed.ok) return { error: parsed.error };

      // Patched in the database rather than read, merged in JavaScript and
      // written back whole. Two agents on the same ticket editing two different
      // fields would otherwise race, and the slower write would carry a stale
      // copy of the other's field and silently undo it — the sidebar saves on
      // every change, so the window is as wide as the round trip.
      //
      // `-` deletes the key instead of storing null. Both read as `is_empty` to
      // the condition language, so this is only about not accumulating keys for
      // fields that were emptied or deleted long ago.
      const patch = isBlank(parsed.value)
        ? sql`${conversations.customFields} - ${def.key}`
        : sql`${conversations.customFields} || ${JSON.stringify({ [def.key]: parsed.value })}::jsonb`;

      const before = row.conversation.customFields[def.key] ?? null;

      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(conversations)
          .set({ customFields: patch })
          .where(eq(conversations.id, conversationId))
          .returning({ customFields: conversations.customFields });

        // The one key that moved, not the whole map: otherwise the timeline says
        // "fields changed" and an agent reading back a week later cannot tell
        // which. Taken from the returned row so it is what was actually stored.
        await tx.insert(conversationEvents).values({
          conversationId,
          type: 'custom_field_changed',
          actorAgentId: agent.id,
          data: {
            key: def.key,
            label: def.label,
            from: before,
            to: updated?.customFields[def.key] ?? null,
          },
        });
      });
      break;
    }
  }

  // Observer rules see the ticket as the agent has just left it. Actions taken
  // by a rule write to the ticket directly and do not come back through here,
  // so a rule cannot trigger itself.
  await afterTicketUpdate(conversationId);

  refresh(row.conversation.number);
  return ok();
}

/**
 * Used by "reply and resolve", which should not need a second round trip.
 *
 * `closed` is absent from the union on purpose. It is the one category behind a
 * permission (`ticket.close`), and this function takes a category rather than a
 * status id from a form, so a future caller passing 'closed' would be a closure
 * that skipped the check in `updateTicket` with nothing to notice it. Leaving it
 * out makes that a compile error instead of a hole.
 */
async function applyStatusCategory(
  agent: SessionAgent,
  conversationId: string,
  category: 'open' | 'pending' | 'resolved',
): Promise<void> {
  const rows = await db
    .select({
      id: ticketStatuses.id,
      name: ticketStatuses.name,
      stopsSlaClock: ticketStatuses.stopsSlaClock,
    })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.category, category))
    .orderBy(ticketStatuses.position)
    .limit(1);

  const status = rows[0];
  if (!status) return;

  await db.transaction(async (tx) => {
    await tx
      .update(conversations)
      .set({
        statusId: status.id,
        resolvedAt: category === 'resolved' ? new Date() : null,
        ...(category === 'resolved' ? { resolvedByAgentId: agent.id } : {}),
        closedAt: null,
      })
      .where(eq(conversations.id, conversationId));

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'status_changed',
      actorAgentId: agent.id,
      data: { to: status.name, category, via: 'reply_and_resolve' },
    });
  });

  await onStatusChanged(conversationId, status.stopsSlaClock);
  if (category === 'resolved') await afterTicketResolved(conversationId);
}

/** The parent for threading: the customer's most recent message. */
async function lastInboundChannelMessageId(conversationId: string): Promise<string | null> {
  const rows = await db
    .select({ channelMessageId: messages.channelMessageId })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'inbound')))
    .orderBy(desc(messages.createdAt))
    .limit(1);

  return rows[0]?.channelMessageId ?? null;
}

// --- Shipments --------------------------------------------------------------

/**
 * Attaching a parcel to a ticket by hand.
 *
 * Deliberately does *not* check the value against the detection pattern. An
 * agent reading a number off a label or out of the shipping platform is more
 * authoritative than our guess at the format — and the whole reason the pattern
 * is configurable is that the guess is known to be incomplete. Refusing what an
 * agent typed because a regular expression disagreed would be the tail wagging
 * the dog.
 */
export async function linkShipment(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.edit_fields')) {
    return { error: 'You do not have permission to change this ticket' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const trackingNumber = normaliseTrackingNumber(String(formData.get('trackingNumber') ?? ''));
  if (!trackingNumber) return { error: 'Enter a tracking number' };

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const shipmentId = await upsertShipmentStub(trackingNumber);
  const created = await attachShipment({
    conversationId,
    shipmentId,
    linkSource: 'manual',
    linkedByAgentId: agent.id,
  });

  if (created) {
    await db.insert(conversationEvents).values({
      conversationId,
      type: 'shipment_linked',
      actorAgentId: agent.id,
      data: { trackingNumber, shipmentId },
    });
  }

  refresh(row.conversation.number);
  return ok();
}

export async function unlinkShipment(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.edit_fields')) {
    return { error: 'You do not have permission to change this ticket' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const shipmentId = String(formData.get('shipmentId') ?? '');
  const trackingNumber = String(formData.get('trackingNumber') ?? '');

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  await detachShipment(conversationId, shipmentId);

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'shipment_unlinked',
    actorAgentId: agent.id,
    data: { trackingNumber, shipmentId },
  });

  refresh(row.conversation.number);
  return ok();
}

/**
 * Fetching one parcel's latest state, while an agent watches.
 *
 * This calls the platform **in the action** rather than queueing a job, and it
 * is the second control in this codebase to do so — `refreshRequesterProfile` is
 * the first, and AGENTS.md writes the exception down precisely so this case can
 * be recognised rather than argued each time. The whole output of the button is
 * the provider's answer: an agent has a customer on the line asking where a
 * parcel is, and queueing the lookup would put the one sentence they are waiting
 * for into a worker log they cannot read.
 *
 * The provider call itself stays in `syncShipment`, shared with the
 * `sync_shipment` job, so the button and the queue cannot answer differently
 * about the same parcel. That is the other half of the rule and the half that
 * matters: the exception is about *who waits*, never about having two paths.
 *
 * `force`, because that is the point of pressing it. Without it a parcel synced
 * four minutes ago returns "synced recently" and the agent has no way to insist.
 *
 * No timeline event is written. `refreshRequesterProfile` records one because it
 * stamps an identity onto a contact — a durable claim somebody should be able to
 * audit. This writes a cache of a public fact that anyone holding the tracking
 * number can read, it is idempotent, and it is pressed repeatedly by design; an
 * entry per press would bury the ticket's actual history.
 */
export async function refreshShipment(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.view')) {
    return { error: 'You do not have permission to look up shipments' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const shipmentId = String(formData.get('shipmentId') ?? '');

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  /*
   * The link is re-read rather than trusted, which is the house rule for any id
   * arriving in a `FormData` field and is load-bearing here: without it the
   * field is an argument to an outbound request, and any signed-in agent could
   * use this ticket as a lever to sync — and so cache into our database — a
   * parcel their permissions never let them see.
   */
  const linked = await db
    .select({ trackingNumber: shipments.trackingNumber })
    .from(conversationShipments)
    .innerJoin(shipments, eq(shipments.id, conversationShipments.shipmentId))
    .where(
      and(
        eq(conversationShipments.conversationId, row.conversation.id),
        eq(conversationShipments.shipmentId, shipmentId),
      ),
    )
    .limit(1);

  if (!linked[0]) return { error: 'That shipment is not linked to this ticket' };

  const result = await syncShipment({ shipmentId, force: true });

  switch (result.kind) {
    case 'synced':
      refresh(row.conversation.number);
      return ok();
    case 'not_found':
      // Recorded on the row by the sync, so the sidebar now says so itself.
      refresh(row.conversation.number);
      return { error: 'The shipping platform does not recognise this number' };
    case 'gone':
      return { error: 'That shipment no longer exists' };
    case 'transient':
      return { error: 'The shipping platform could not be reached. Try again in a moment.' };
    case 'refused':
      return { error: `The shipping platform refused the lookup: ${result.error.message}` };
    case 'skipped':
      // Unreachable with `force`, and enumerated so a new result kind is a type
      // error here rather than a silent success in front of an agent.
      return ok();
  }
}

export async function linkShippingAccount(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.edit_fields')) {
    return { error: 'You do not have permission to change this ticket' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const sbid = normaliseSbid(String(formData.get('sbid') ?? ''));
  if (!sbid) return { error: 'Enter an SBID' };

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const shippingAccountId = await upsertShippingAccountStub(sbid);
  const created = await attachShippingAccount({
    conversationId,
    shippingAccountId,
    linkSource: 'manual',
    linkedByAgentId: agent.id,
  });

  if (created) {
    await db.insert(conversationEvents).values({
      conversationId,
      type: 'shipping_account_linked',
      actorAgentId: agent.id,
      data: { sbid, shippingAccountId },
    });
  }

  refresh(row.conversation.number);
  return ok();
}

export async function unlinkShippingAccount(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.edit_fields')) {
    return { error: 'You do not have permission to change this ticket' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const shippingAccountId = String(formData.get('shippingAccountId') ?? '');
  const sbid = String(formData.get('sbid') ?? '');

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  await detachShippingAccount(conversationId, shippingAccountId);

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'shipping_account_unlinked',
    actorAgentId: agent.id,
    data: { sbid, shippingAccountId },
  });

  refresh(row.conversation.number);
  return ok();
}

// --- Side conversations -----------------------------------------------------

/**
 * The thread an agent opens with a hub, a warehouse or a vendor.
 *
 * Every write here re-runs `loadConversation`, so a thread is only reachable
 * through a ticket the agent may see. Reaching a side conversation by id alone
 * would be a way past the ticket visibility rule, which is the same bug
 * `loadConversation` exists to prevent on the ticket itself.
 */

/** Every address we know the requester by — the addresses a send is refused for. */
async function requesterAddresses(contactId: string): Promise<string[]> {
  const rows = await db
    .select({
      primaryEmail: contacts.primaryEmail,
      identifier: contactIdentities.identifier,
      channel: contactIdentities.channel,
    })
    .from(contacts)
    .leftJoin(contactIdentities, eq(contactIdentities.contactId, contacts.id))
    .where(eq(contacts.id, contactId));

  const addresses = new Set<string>();
  for (const row of rows) {
    if (row.primaryEmail) addresses.add(row.primaryEmail.toLowerCase());
    // Only the email identities: a phone number is not an address this could be
    // sent to, and including it would refuse nothing while looking like it did.
    if (row.channel === 'email' && row.identifier) addresses.add(row.identifier.toLowerCase());
  }

  return [...addresses];
}

export async function startSideConversation(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.side_conversation')) {
    return { error: 'You do not have permission to start a side conversation' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const body = text(formData, 'body');
  if (!body) return { error: 'Write your question first' };

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  // A bot transcript is a copy of somebody else's conversation. Escalating one
  // to a hub means asking them to act on a thread nobody here is working.
  const readOnly = refuseIfReadOnly(row.conversation.channel);
  if (readOnly) return readOnly;

  const conversation = row.conversation;

  // --- Who it goes to ------------------------------------------------------

  /*
   * The picker offers two registers in one list, so its value carries which:
   * `location:<uuid>` for one of the sixteen places ShipBlu works out of,
   * `recipient:<uuid>` for a party that is not a place, `other` for free text.
   *
   * The address is re-read from the row here rather than taken from a hidden
   * form field. A field would be an address the browser supplied, and the whole
   * point of a directory is that the address comes from somewhere an admin
   * controls — otherwise the picker is a text box wearing a dropdown.
   */
  const picked = String(formData.get('recipientId') ?? '');
  const typedAddress = String(formData.get('toAddress') ?? '');

  let toAddress: string;
  let resolvedRecipientId: string | null = null;
  let resolvedLocationId: string | null = null;

  if (picked.startsWith('location:')) {
    const id = picked.slice('location:'.length);
    const rows = await db
      .select({ id: locations.id, email: locations.email })
      .from(locations)
      .where(and(eq(locations.id, id), eq(locations.isActive, true)))
      .limit(1);

    const place = rows[0];
    if (!place) return { error: 'That location is no longer available' };

    resolvedLocationId = place.id;
    toAddress = place.email;
  } else if (picked.startsWith('recipient:')) {
    const id = picked.slice('recipient:'.length);
    const rows = await db
      .select({ id: internalRecipients.id, email: internalRecipients.email })
      .from(internalRecipients)
      .where(and(eq(internalRecipients.id, id), eq(internalRecipients.isActive, true)))
      .limit(1);

    const recipient = rows[0];
    if (!recipient) return { error: 'That recipient is no longer available' };

    resolvedRecipientId = recipient.id;
    toAddress = recipient.email;
  } else {
    toAddress = normaliseAddress(typedAddress);
  }

  const ccAddresses = parseAddressList(String(formData.get('ccAddresses') ?? ''));

  // Re-checked here and not only in the composer. Hiding a control stops the
  // honest path; this stops the others — a stale tab, a resubmitted form, a
  // hand-made POST — and this is the refusal that keeps an internal thread away
  // from the person it is about.
  const check = {
    ourAddresses: [env().EMAIL_FROM_ADDRESS].filter((a): a is string => Boolean(a)),
    requesterAddresses: await requesterAddresses(conversation.requesterContactId),
  };

  const refusal = refuseRecipient(toAddress, check) ?? refuseRecipients(ccAddresses, check) ?? null;
  if (refusal) return { error: refusal };

  // --- What it says --------------------------------------------------------

  const subject = text(formData, 'subject') || (conversation.subject ?? '(no subject)');

  const anchorMessageId = String(formData.get('anchorMessageId') ?? '') || null;

  let outboundBody = body;
  if (formData.get('includeAnchor') === 'on' && anchorMessageId) {
    const quoted = await quotedAnchorMessage(conversationId, anchorMessageId);
    if (quoted) outboundBody = `${body}\n\n${quoted}`;
  }

  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(sideConversations)
      .values({
        conversationId,
        anchorMessageId,
        channel: 'email',
        subject,
        recipientId: resolvedRecipientId,
        locationId: resolvedLocationId,
        toAddresses: [toAddress],
        ccAddresses,
        createdByAgentId: agent.id,
        lastMessageAt: new Date(),
      })
      .returning({ id: sideConversations.id, number: sideConversations.number });

    const side = inserted[0]!;

    const message = await tx
      .insert(sideConversationMessages)
      .values({
        sideConversationId: side.id,
        direction: 'outbound',
        authorAgentId: agent.id,
        toAddresses: [toAddress],
        ccAddresses,
        bodyText: outboundBody,
        deliveryStatus: 'pending',
      })
      .returning({ id: sideConversationMessages.id });

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'side_conversation_started',
      actorAgentId: agent.id,
      data: { sideConversationNumber: side.number, to: toAddress, subject },
    });

    return { ...side, messageId: message[0]!.id };
  });

  await enqueue(
    'send_side_email',
    { messageId: created.messageId },
    { priority: 10, dedupeKey: `send_side:${created.messageId}` },
  );

  // Offered rather than done silently. The agent asked somebody a question, so
  // the ticket is genuinely waiting on a third party — but pausing an SLA clock
  // behind a thread the customer cannot see would make the report stop matching
  // what the customer experienced, so the status is theirs to set.
  if (formData.get('setPending') === 'on') {
    await applyStatusCategory(agent, conversationId, 'pending');
  }

  refresh(conversation.number);
  return ok();
}

export async function replyToSideConversation(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.side_conversation')) {
    return { error: 'You do not have permission to write in a side conversation' };
  }

  const sideConversationId = String(formData.get('sideConversationId') ?? '');
  const body = text(formData, 'body');
  if (!body) return { error: 'Write something first' };

  const side = await loadSideConversation(sideConversationId);
  if (!side) return { error: 'Side conversation not found' };

  // The ticket's own visibility rule, applied to the thread hanging off it.
  const row = await loadConversation(agent, side.side.conversationId);
  if (!row) return { error: 'Side conversation not found' };

  const parentMessageId = await lastSideMessageId(sideConversationId);

  const inserted = await db
    .insert(sideConversationMessages)
    .values({
      sideConversationId,
      direction: 'outbound',
      authorAgentId: agent.id,
      toAddresses: side.side.toAddresses,
      ccAddresses: side.side.ccAddresses,
      bodyText: body,
      inReplyTo: parentMessageId,
      deliveryStatus: 'pending',
    })
    .returning({ id: sideConversationMessages.id });

  const messageId = inserted[0]!.id;

  await db
    .update(sideConversations)
    .set({
      lastMessageAt: new Date(),
      // Answering reopens a thread the agent had marked done, because they have
      // just asked something else on it.
      ...(side.side.state === 'done'
        ? { state: 'open' as const, closedAt: null, closedByAgentId: null }
        : {}),
    })
    .where(eq(sideConversations.id, sideConversationId));

  await enqueue(
    'send_side_email',
    { messageId },
    { priority: 10, dedupeKey: `send_side:${messageId}` },
  );

  refresh(row.conversation.number);
  return ok();
}

/** Mark a thread done, or reopen one. */
export async function setSideConversationState(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.side_conversation')) {
    return { error: 'You do not have permission to change a side conversation' };
  }

  const sideConversationId = String(formData.get('sideConversationId') ?? '');
  const state = String(formData.get('state') ?? '');
  if (state !== 'open' && state !== 'done') return { error: 'Unknown state' };

  const side = await loadSideConversation(sideConversationId);
  if (!side) return { error: 'Side conversation not found' };

  const row = await loadConversation(agent, side.side.conversationId);
  if (!row) return { error: 'Side conversation not found' };

  await db
    .update(sideConversations)
    .set(
      state === 'done'
        ? { state, closedAt: new Date(), closedByAgentId: agent.id }
        : { state, closedAt: null, closedByAgentId: null },
    )
    .where(eq(sideConversations.id, sideConversationId));

  refresh(row.conversation.number);
  return ok();
}

/**
 * The customer's message, as the hub will see it quoted.
 *
 * Scoped by conversation id as well as message id: the anchor arrives from a
 * form field, and a message id from another ticket must not be quotable into
 * this one's side conversation.
 */
async function quotedAnchorMessage(
  conversationId: string,
  messageId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      bodyText: messages.bodyText,
      kind: messages.kind,
      createdAt: messages.createdAt,
      contactName: contacts.name,
    })
    .from(messages)
    .leftJoin(contacts, eq(contacts.id, messages.authorContactId))
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
    .limit(1);

  const message = rows[0];
  if (!message) return null;
  // A private note is ours, not the customer's, and forwarding one to a hub
  // under the heading "the customer wrote" would be a lie about who said it.
  if (message.kind === 'note') return null;

  return quoteAnchor(message.contactName, message.bodyText, message.createdAt);
}

export type AvailabilityState = { error: string | null; accepting?: boolean };

/**
 * The agent's own availability switch.
 *
 * Needs no permission beyond being signed in: it is a statement about
 * themselves, and the only thing it can do is send fewer tickets their way.
 *
 * Turning it back on asks the sweep to look at the queue, so somebody coming out
 * of a meeting picks up what is waiting rather than waiting for the next
 * five-minute tick.
 */
export async function setAcceptingTickets(
  _state: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  const agent = await requireAgent();
  const accepting = formData.get('accepting') === 'true';

  // Through the presence module rather than writing the column here: the switch
  // marks the boundary between available and merely present, and that boundary
  // has to land in the presence history or "available time" in the productivity
  // report counts an agent who spent the afternoon in a meeting as working it.
  //
  // `self` is what stops the idle machinery undoing this. An agent who turns
  // themselves off before a meeting keeps the tab open and keeps moving the
  // mouse; if this were recorded as idleness, the first keypress would put them
  // back in the rota (see `availabilityReasonEnum`).
  await setAccepting(agent.id, accepting, 'self');

  if (accepting) await requestAssignmentSweep();

  revalidatePath('/inbox');
  return { error: null, accepting };
}

/**
 * Somebody else's availability, set by a supervisor or an admin.
 *
 * The queue-covering counterpart to the switch above: an agent who has walked
 * away with tickets routing to them, or one whose switch is still off an hour
 * after the meeting ended while the queue backs up.
 *
 * Recorded as `supervisor`, which is what makes it survive the agent returning
 * to their keyboard — an automatic away is undone by input, a decision is not.
 * It is not a lock: the agent's own switch still works, and an agent who
 * disagrees can turn it back. That is deliberate, and the alternative is worse
 * — an agent silently unable to take work with nothing on screen to say why.
 *
 * The id arrives in a form field, so the row is re-read here rather than
 * trusted: the target has to be a real, active agent before anything is
 * written.
 */
export async function setAgentAvailability(
  _state: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  await requirePermission('agent.availability');

  const accepting = formData.get('accepting') === 'true';

  // Shape-checked before it reaches the query. A uuid column compared against
  // "banana" is a Postgres error (22P02), not an empty result, so without this
  // a mistyped id is a 500 rather than "no such agent".
  const agentId = z.uuid().safeParse(formData.get('agentId'));
  if (!agentId.success) return { error: 'That agent could not be found.' };

  const rows = await db
    .select({ id: agents.id, name: agents.name, isActive: agents.isActive })
    .from(agents)
    .where(eq(agents.id, agentId.data))
    .limit(1);

  const target = rows[0];
  if (!target) return { error: 'That agent could not be found.' };

  // A deactivated agent is already excluded from every queue. Writing an
  // availability onto them would leave a value nobody can see or undo, because
  // they never appear on this page again.
  if (!target.isActive) return { error: `${target.name} is deactivated.` };

  await setAccepting(target.id, accepting, 'supervisor');

  if (accepting) await requestAssignmentSweep();

  revalidatePath('/reports/team');
  return { error: null, accepting };
}

// --- Categories and root cause ----------------------------------------------

/**
 * An agent's answer to what the detector proposed.
 *
 * Four verbs on a category, and the shape of each is the human-in-the-loop
 * design rather than CRUD on a join table:
 *
 * - **confirm** says the rule was right, and keeps the `confidence` and
 *   `rule_key` it asserted. Those are what the tuning pass measures; clearing
 *   them on confirmation would destroy the only record of whether the rule was
 *   any good.
 * - **reject** says it was wrong, and **keeps the row**. A rejected assignment
 *   still occupies `(conversation, category)`, which is what stops the next
 *   message re-suggesting it — the agent's judgement survives without a single
 *   `where` clause anywhere having to remember it.
 * - **add** is a person filing what the rules missed, which is the other half of
 *   the same signal: a category arriving by hand far more often than by rule is
 *   a gap in the lexicon.
 * - **remove** takes back an agent's own addition, and is the one path that
 *   deletes — there is nothing to learn from somebody undoing their own click.
 */
type CategoryTarget =
  | { ok: false; error: string }
  | {
      ok: true;
      agent: SessionAgent;
      conversationId: string;
      categoryId: string;
      category: { id: string; key: string };
      number: number;
    };

async function resolveCategoryTarget(formData: FormData): Promise<CategoryTarget> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.categorise')) {
    return { ok: false, error: 'You do not have permission to categorise tickets' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const categoryId = String(formData.get('categoryId') ?? '');
  if (!conversationId || !categoryId) return { ok: false, error: 'Choose a category' };

  // Re-read both sides rather than trusting the ids in the form: the
  // conversation so channel visibility is checked at this entry point too, and
  // the category so a request naming a row that has since gone fails instead of
  // writing a dangling assignment.
  const row = await loadConversation(agent, conversationId);
  if (!row) return { ok: false, error: 'Ticket not found' };

  const category = await db
    .select({ id: ticketCategories.id, key: ticketCategories.key })
    .from(ticketCategories)
    .where(eq(ticketCategories.id, categoryId))
    .limit(1);

  if (!category[0]) return { ok: false, error: 'That category no longer exists' };

  return {
    ok: true,
    agent,
    conversationId,
    categoryId,
    category: category[0],
    number: row.conversation.number,
  };
}

export async function addCategory(_state: ActionState, formData: FormData): Promise<ActionState> {
  const target = await resolveCategoryTarget(formData);
  if (!target.ok) return { error: target.error };
  const { agent, conversationId, categoryId, category, number } = target;

  // `onConflictDoUpdate` rather than `DoNothing`, and this is the one path
  // allowed to overturn a rejection: a person adding a category the detector
  // suggested, or that somebody previously threw out, is making an explicit
  // decision and it should win.
  const claim = {
    source: 'manual' as const,
    reviewState: 'confirmed' as const,
    confidence: 1,
    assignedByAgentId: agent.id,
    reviewedByAgentId: agent.id,
    reviewedAt: new Date(),
  };

  await db
    .insert(conversationCategories)
    .values({ conversationId, categoryId, categoryKey: category.key, ...claim })
    .onConflictDoUpdate({
      target: [conversationCategories.conversationId, conversationCategories.categoryId],
      set: claim,
    });

  await refreshPrimary(conversationId);
  await db.insert(conversationEvents).values({
    conversationId,
    type: 'category_added',
    actorAgentId: agent.id,
    data: { categoryKey: category.key },
  });

  refresh(number);
  return ok();
}

export async function confirmCategory(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const target = await resolveCategoryTarget(formData);
  if (!target.ok) return { error: target.error };
  const { agent, conversationId, categoryId, category, number } = target;

  await db
    .update(conversationCategories)
    .set({ reviewState: 'confirmed', reviewedByAgentId: agent.id, reviewedAt: new Date() })
    .where(
      and(
        eq(conversationCategories.conversationId, conversationId),
        eq(conversationCategories.categoryId, categoryId),
      ),
    );

  await refreshPrimary(conversationId);
  await db.insert(conversationEvents).values({
    conversationId,
    type: 'category_confirmed',
    actorAgentId: agent.id,
    data: { categoryKey: category.key },
  });

  refresh(number);
  return ok();
}

export async function rejectCategory(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const target = await resolveCategoryTarget(formData);
  if (!target.ok) return { error: target.error };
  const { agent, conversationId, categoryId, category, number } = target;

  // A state change, never a delete. `source` is left alone so a report can tell
  // "a rule was thrown out" from "an agent removed their own", and `is_primary`
  // is cleared in the same statement because a CHECK forbids a rejected row
  // from being one.
  await db
    .update(conversationCategories)
    .set({
      reviewState: 'rejected',
      isPrimary: false,
      reviewedByAgentId: agent.id,
      reviewedAt: new Date(),
    })
    .where(
      and(
        eq(conversationCategories.conversationId, conversationId),
        eq(conversationCategories.categoryId, categoryId),
      ),
    );

  await refreshPrimary(conversationId);
  await db.insert(conversationEvents).values({
    conversationId,
    type: 'category_rejected',
    actorAgentId: agent.id,
    data: { categoryKey: category.key },
  });

  refresh(number);
  return ok();
}

export async function removeCategory(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const target = await resolveCategoryTarget(formData);
  if (!target.ok) return { error: target.error };
  const { agent, conversationId, categoryId, category, number } = target;

  // Scoped to `manual`: deleting a detected row would throw away the evidence
  // that a rule fired, which is what the tuning pass reads. A detected row is
  // rejected instead.
  await db
    .delete(conversationCategories)
    .where(
      and(
        eq(conversationCategories.conversationId, conversationId),
        eq(conversationCategories.categoryId, categoryId),
        eq(conversationCategories.source, 'manual'),
      ),
    );

  await refreshPrimary(conversationId);
  await db.insert(conversationEvents).values({
    conversationId,
    type: 'category_removed',
    actorAgentId: agent.id,
    data: { categoryKey: category.key },
  });

  refresh(number);
  return ok();
}

/**
 * Why this ticket happened, recorded by the agent who looked into it.
 *
 * Accepts an empty value so a cause set by mistake can be cleared — the resolve
 * gate will ask again, which is the right outcome for a ticket somebody is
 * still working out.
 */
export async function setRootCause(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.categorise')) {
    return { error: 'You do not have permission to categorise tickets' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const rootCauseId = String(formData.get('rootCauseId') ?? '');

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  let key: string | null = null;
  if (rootCauseId) {
    const cause = await db
      .select({ key: ticketRootCauses.key })
      .from(ticketRootCauses)
      .where(eq(ticketRootCauses.id, rootCauseId))
      .limit(1);
    if (!cause[0]) return { error: 'That root cause no longer exists' };
    key = cause[0].key;
  }

  await db
    .update(conversations)
    .set({
      rootCauseId: rootCauseId || null,
      // Cleared with the cause, so a ticket whose cause was removed cannot be
      // counted on the day the removed one was established.
      rootCauseSetAt: rootCauseId ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'root_cause_set',
    actorAgentId: agent.id,
    data: { rootCauseKey: key },
  });

  refresh(row.conversation.number);
  return ok();
}

const PURGE_ERRORS: Record<PurgeRefusal, string> = {
  not_found: 'That ticket no longer exists — somebody may have deleted it already',
  confirmation_mismatch: 'That is not the ticket number. Type it exactly as shown.',
};

/**
 * Destroys a ticket and everything on it.
 *
 * The one action in the console with no undo, so it is gated three ways rather
 * than one: `ticket.purge` (admin only, and not inherited from
 * `ticket.view.all`), the channel visibility rule every other ticket action
 * applies, and a typed confirmation of the ticket number that
 * `purgeConversation()` re-derives from the locked row inside its own
 * transaction. The form field is never the authority on what is being deleted —
 * it only has to agree with what the database says.
 *
 * `loadConversation()` is reused deliberately: an admin who cannot see the bot
 * channel must not be able to delete a ticket on it, and that rule already lives
 * in one place. It only covers the ticket on screen, though, and the purge also
 * takes every ticket merged into it — so `hiddenScopeRefusal()` asks the same
 * question of those.
 */
export async function purgeTicket(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.purge')) {
    return { error: 'You do not have permission to delete tickets' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  if (!isUuid(conversationId)) return { error: 'No ticket to delete' };

  const loaded = await loadConversation(agent, conversationId);
  if (!loaded) return { error: PURGE_ERRORS.not_found };

  const hidden = await hiddenScopeRefusal(agent, { conversationId });
  if (hidden) return { error: hidden };

  const result = await purgeConversation({
    conversationId,
    confirmation: String(formData.get('confirmation') ?? ''),
    agent: { id: agent.id, name: agent.name },
  });

  if (!result.ok) return { error: PURGE_ERRORS[result.reason] };

  // Other agents' inboxes stay stale until they navigate — the notify trigger is
  // INSERT/UPDATE only, so a delete raises no event, and adding one would mean a
  // DELETE trigger whose payload names a row nobody can read.
  revalidatePath('/inbox');
  revalidatePath('/contacts');
  revalidatePath('/admin/categories/review');

  // The redirect happens here, not in the panel. A server action that
  // revalidates makes Next re-render the route the form was posted from in the
  // same response, and that route is this ticket — whose row is now gone, so
  // its page calls notFound() and the 404 replaces the tree before any client
  // effect could navigate away. A redirect from the action makes the response
  // carry the inbox instead. It throws, so it stays last and outside any try.
  redirect('/inbox');
}
