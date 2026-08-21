'use server';

import { revalidatePath } from 'next/cache';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  contactIdentities,
  conversationEvents,
  conversations,
  contacts,
  internalRecipients,
  locations,
  messages,
  sideConversationMessages,
  sideConversations,
  ticketStatuses,
  whatsappTemplates,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { requestAssignmentSweep, setAccepting } from '@/lib/assignment/presence';
import { requireAgent } from '@/lib/auth/guard';
import { env } from '@/lib/env';
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
import { quoteAnchor } from '@/lib/side-conversations/format';
import {
  normaliseAddress,
  parseAddressList,
  refuseRecipient,
  refuseRecipients,
} from '@/lib/side-conversations/guard';
import { lastSideMessageId, loadSideConversation } from '@/lib/side-conversations/queries';
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

      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ groupId })
          .where(eq(conversations.id, conversationId));

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
        ...(category === 'resolved' ? { resolvedByAgentId: agent.id } : {}),
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
  const body = String(formData.get('body') ?? '').trim();
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

  const subject =
    String(formData.get('subject') ?? '').trim() || (conversation.subject ?? '(no subject)');

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
  const body = String(formData.get('body') ?? '').trim();
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
  _state: { error: string | null; accepting?: boolean },
  formData: FormData,
): Promise<{ error: string | null; accepting?: boolean }> {
  const agent = await requireAgent();
  const accepting = formData.get('accepting') === 'true';

  // Through the presence module rather than writing the column here: the switch
  // marks the boundary between available and merely present, and that boundary
  // has to land in the presence history or "available time" in the productivity
  // report counts an agent who spent the afternoon in a meeting as working it.
  await setAccepting(agent.id, accepting);

  if (accepting) await requestAssignmentSweep();

  revalidatePath('/inbox');
  return { error: null, accepting };
}
