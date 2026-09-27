'use server';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  contactIdentities,
  contacts,
  conversationEvents,
  internalRecipients,
  locations,
  messages,
  sideConversationMessages,
  sideConversations,
} from '@/db/schema';
import { requireAgent } from '@/lib/auth/guard';
import { text } from '@/lib/http/form-data';
import { ok } from '@/lib/http/action-state';
import { env } from '@/lib/env';
import { can } from '@/lib/auth/permissions';
import { enqueue } from '@/lib/queue';
import { quoteAnchor } from '@/lib/side-conversations/format';
import {
  normaliseAddress,
  parseAddressList,
  refuseRecipient,
  refuseRecipients,
} from '@/lib/side-conversations/guard';
import { lastSideMessageId, loadSideConversation } from '@/lib/side-conversations/queries';
import {
  applyStatusCategory,
  loadConversation,
  refresh,
  refuseIfReadOnly,
} from '@/lib/tickets/console-guards';
import type { ActionState } from './actions';

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
