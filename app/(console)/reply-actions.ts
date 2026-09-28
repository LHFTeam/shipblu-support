'use server';

import { and, eq, sql, desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses, messages, whatsappTemplates } from '@/db/schema';
import { requireAgent } from '@/lib/auth/guard';
import { text } from '@/lib/http/form-data';
import { ok } from '@/lib/http/action-state';
import { can } from '@/lib/auth/permissions';
import { sendsByEmail } from '@/lib/tickets/outbound';
import { htmlToText, sanitiseEmailHtml, textToHtml } from '@/lib/html/sanitize';
import { afterMessageStored } from '@/lib/tickets/lifecycle';
import { storeAgentReply } from '@/lib/tickets/agent-reply';
import {
  buildTemplateComponents,
  renderTemplatePreview,
  templateShape,
  TemplateParameterError,
} from '@/lib/whatsapp/templates';
import { metaWindowState } from '@/lib/meta/window';
import { metaReplyTarget } from '@/lib/tickets/meta-thread';
import { accountIdForConversation } from '@/lib/whatsapp/conversation';
import { windowState } from '@/lib/whatsapp/window';
import {
  applyStatusCategory,
  loadConversation,
  refresh,
  refuseIfIncomplete,
  refuseIfNoRootCause,
  refuseIfReadOnly,
} from '@/lib/tickets/console-guards';
import type { ActionState } from './action-state';
import { logger } from '@/lib/log';

const log = logger('canned');

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

  await storeAgentReply(conversationId, conversation.channel, {
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
    log.warn('could not record a use', error);
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
    text(formData, `body_${index + 1}`),
  );
  const headerValues = Array.from({ length: shape.headerVariableCount }, (_, index) =>
    text(formData, `header_${index + 1}`),
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

  // The most predictable source of a tracking number in the whole system: the
  // shipment_update template's body is "Hi {{1}}, your shipment {{2}} is out
  // for delivery today", and {{2}} is filled in above.
  await storeAgentReply(conversationId, row.conversation.channel, {
    authorAgentId: agent.id,
    bodyText: rendered,
    deliveryStatus: 'pending',
    meta: {
      sendKind: 'template',
      template: { name: template.name, language: template.language, components },
      templateName: template.name,
    },
  });

  refresh(row.conversation.number);
  return ok();
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
