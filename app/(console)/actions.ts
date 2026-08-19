'use server';

import { revalidatePath } from 'next/cache';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  conversationEvents,
  conversations,
  contacts,
  messages,
  ticketStatuses,
  whatsappTemplates,
} from '@/db/schema';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { canSeeChannel, readOnlyReason } from '@/lib/tickets/channel-policy';
import type { SessionAgent } from '@/lib/auth/session';
import { htmlToText, sanitiseEmailHtml } from '@/lib/html/sanitize';
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
import { metaWindowState } from '@/lib/meta/window';
import {
  attachShipment,
  attachShippingAccount,
  detachShipment,
  detachShippingAccount,
  upsertShipmentStub,
  upsertShippingAccountStub,
} from '@/lib/shipments/links';
import { normaliseSbid, normaliseTrackingNumber } from '@/lib/shipments/format';
import { windowState } from '@/lib/whatsapp/window';

/**
 * Console write actions.
 *
 * All of them follow the same shape: authorise, write the row, record an audit
 * event, and enqueue any outbound work. Delivery never happens inline — the
 * agent's reply is saved and visible before a provider is contacted, so an
 * outage delays the send instead of losing what they wrote.
 */

export type ActionState = {
  error: string | null;
  ok?: boolean;
  /**
   * Changes on every success. The composer keys its form on this so a second
   * consecutive send still clears the textarea — `ok: true` alone is the same
   * value twice and would leave the previous reply sitting in the box.
   */
  nonce?: number;
};

function ok(): ActionState {
  return { error: null, ok: true, nonce: Date.now() };
}

async function loadConversation(agent: SessionAgent, conversationId: string) {
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
}

// --- Replies and notes ------------------------------------------------------

export async function sendReply(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.reply')) return { error: 'You do not have permission to reply' };

  const conversationId = String(formData.get('conversationId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  const resolveAfter = formData.get('resolveAfter') === 'on';

  if (!body) return { error: 'Write something first' };

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const conversation = row.conversation;

  const readOnly = refuseIfReadOnly(conversation.channel);
  if (readOnly) return readOnly;

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

  const isEmail = conversation.channel === 'email';
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
      conversation.channel === 'whatsapp' ? 'send_whatsapp' : isMeta ? 'send_meta' : 'send_email',
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
  });

  if (resolveAfter) {
    await applyStatusCategory(agent, conversation.id, 'resolved');
  }

  refresh(conversation.number);
  return ok();
}

export async function addNote(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.note')) return { error: 'You do not have permission to add notes' };

  const conversationId = String(formData.get('conversationId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
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

  const templates = await db
    .select()
    .from(whatsappTemplates)
    .where(eq(whatsappTemplates.id, templateId))
    .limit(1);

  const template = templates[0];
  if (!template) return { error: 'Template not found' };
  if (template.status !== 'APPROVED') {
    return { error: `Template "${template.name}" is ${template.status.toLowerCase()} in Meta` };
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

      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({
            statusId: status.id,
            resolvedAt: status.category === 'resolved' ? new Date() : null,
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

      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ assigneeAgentId })
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
      await db
        .update(conversations)
        .set({ groupId: value || null })
        .where(eq(conversations.id, conversationId));

      // Groups can keep their own operating days and holidays, so the due dates
      // are re-counted on the new team's calendar rather than left pointing at
      // hours that team does not work.
      await onGroupChanged(conversationId);
      break;
    }

    case 'priority': {
      if (!['low', 'medium', 'high', 'urgent'].includes(value))
        return { error: 'Unknown priority' };

      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ priority: value as 'low' | 'medium' | 'high' | 'urgent' })
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

    default:
      return { error: `Unknown field "${field}"` };
  }

  // Observer rules see the ticket as the agent has just left it. Actions taken
  // by a rule write to the ticket directly and do not come back through here,
  // so a rule cannot trigger itself.
  await afterTicketUpdate(conversationId);

  refresh(row.conversation.number);
  return ok();
}

/** Used by "reply and resolve", which should not need a second round trip. */
async function applyStatusCategory(
  agent: SessionAgent,
  conversationId: string,
  category: 'open' | 'pending' | 'resolved' | 'closed',
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
        closedAt: category === 'closed' ? new Date() : null,
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

/**
 * The composer is plain text. Converting here rather than shipping a rich-text
 * editor keeps the sanitiser's job small — there is no agent-authored markup to
 * validate, only our own.
 */
function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
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
