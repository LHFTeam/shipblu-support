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
import { can } from '@/lib/auth/permissions';
import type { SessionAgent } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { isUuid } from '@/lib/http/uuid';
import { enqueue } from '@/lib/queue';
import { readOnlyReason } from '@/lib/tickets/channel-policy';
import { applyStatusCategory, loadConversation } from '@/lib/tickets/console-guards';
import { isReaction } from '@/lib/whatsapp/reaction';
import { holdEntry } from './directory';
import { quoteAnchor, sideSubject } from './format';
import { normaliseAddress, parseAddressList, refuseRecipient, refuseRecipients } from './guard';
import { lastSideMessageId, loadSideConversation } from './queries';

/**
 * Every write to a side conversation, whoever asked for it.
 *
 * Two callers: the console's server actions and the WhatsApp Web extension's
 * routes. One copy, because what is written here is a message to a third party
 * about a customer, and the checks in front of it — the agent's permission, the
 * ticket's visibility, an address re-read from the directory rather than taken
 * from the request, and `guard.ts`'s refusal of the customer's own address —
 * are the whole safety story of the feature. A second copy of them is a second
 * place for one to go missing.
 *
 * Each answers the refusal as a sentence for the agent, or the ticket's number
 * so the caller can refresh what it shows.
 */
export type SideWriteResult = { error: string } | { error: null; conversationNumber: number };

export type StartSideConversationInput = {
  conversationId: string;
  body: string;
  /**
   * The picker's value: `location:<uuid>` for one of the places ShipBlu works
   * out of, `recipient:<uuid>` for a party that is not a place, `other` for the
   * typed address below.
   */
  recipientId: string;
  /** Read only when `recipientId` is `other`. */
  toAddress: string;
  /** Comma- or newline-separated, as the composer's field has it. */
  ccAddresses: string;
  subject: string;
  anchorMessageId: string | null;
  includeAnchor: boolean;
  setPending: boolean;
};

export async function startSideConversation(
  agent: SessionAgent,
  input: StartSideConversationInput,
): Promise<SideWriteResult> {
  if (!can(agent, 'ticket.side_conversation')) {
    return { error: 'You do not have permission to start a side conversation' };
  }

  const body = input.body.trim();
  if (!body) return { error: 'Write your question first' };

  const row = await loadConversation(agent, input.conversationId);
  if (!row) return { error: 'Ticket not found' };

  // A bot transcript is a copy of somebody else's conversation. Escalating one
  // to a hub means asking them to act on a thread nobody here is working.
  const readOnly = readOnlyReason(row.conversation.channel);
  if (readOnly) return { error: readOnly };

  const conversation = row.conversation;
  const conversationId = conversation.id;

  // --- Who it goes to ------------------------------------------------------

  /*
   * The address is re-read from the row here rather than taken from the
   * request. A field would be an address the browser supplied, and the whole
   * point of a directory is that the address comes from somewhere an admin
   * controls — otherwise the picker is a text box wearing a dropdown.
   */
  const picked = input.recipientId;

  let toAddress: string;
  let resolvedRecipientId: string | null = null;
  let resolvedLocationId: string | null = null;

  if (picked.startsWith('location:')) {
    const id = picked.slice('location:'.length);
    const rows = isUuid(id)
      ? await db
          .select({ id: locations.id, email: locations.email })
          .from(locations)
          .where(and(eq(locations.id, id), eq(locations.isActive, true)))
          .limit(1)
      : [];

    const place = rows[0];
    if (!place) return { error: 'That location is no longer available' };

    resolvedLocationId = place.id;
    toAddress = place.email;
  } else if (picked.startsWith('recipient:')) {
    const id = picked.slice('recipient:'.length);
    const rows = isUuid(id)
      ? await db
          .select({ id: internalRecipients.id, email: internalRecipients.email })
          .from(internalRecipients)
          .where(and(eq(internalRecipients.id, id), eq(internalRecipients.isActive, true)))
          .limit(1)
      : [];

    const recipient = rows[0];
    if (!recipient) return { error: 'That recipient is no longer available' };

    resolvedRecipientId = recipient.id;
    toAddress = recipient.email;
  } else {
    // `other`, and also the picker's unchosen "Choose…", which `required` stops
    // in the browser. Sent anyway, it arrives with no typed address either —
    // the field is only rendered for `other` — and `refuseRecipient` answers it.
    toAddress = normaliseAddress(input.toAddress);
  }

  const ccAddresses = parseAddressList(input.ccAddresses);

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

  const subject = sideSubject(input.subject, conversation.subject);

  // A malformed id is no anchor, not a 22P02 out of the insert below.
  const anchorMessageId =
    input.anchorMessageId && isUuid(input.anchorMessageId) ? input.anchorMessageId : null;

  let outboundBody = body;
  if (input.includeAnchor && anchorMessageId) {
    const quoted = await quotedAnchorMessage(conversationId, anchorMessageId);
    if (quoted) outboundBody = `${body}\n\n${quoted}`;
  }

  const created = await db.transaction(async (tx) => {
    // Checked again, under a lock, because the read that resolved the address
    // took none: an admin could delete or retire the hub since, and the insert
    // would then die on the foreign key or go to a hub just marked not operating.
    // `holdEntry` says how the lock and the delete's wait for each other.
    const open = resolvedLocationId
      ? await holdEntry(tx, 'location', resolvedLocationId)
      : resolvedRecipientId
        ? await holdEntry(tx, 'recipient', resolvedRecipientId)
        : true;
    if (!open) return null;

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

  if (!created) {
    return {
      error: resolvedLocationId
        ? 'That location is no longer available'
        : 'That recipient is no longer available',
    };
  }

  await enqueue(
    'send_side_email',
    { messageId: created.messageId },
    { priority: 10, dedupeKey: `send_side:${created.messageId}` },
  );

  // Offered rather than done silently. The agent asked somebody a question, so
  // the ticket is genuinely waiting on a third party — but pausing an SLA clock
  // behind a thread the customer cannot see would make the report stop matching
  // what the customer experienced, so the status is theirs to set.
  if (input.setPending) {
    await applyStatusCategory(agent, conversationId, 'pending');
  }

  return { error: null, conversationNumber: conversation.number };
}

/**
 * A side conversation, through the ticket it hangs off.
 *
 * Reaching a thread by its id alone would be a way past the ticket visibility
 * rule — the same bug `loadConversation` exists to prevent on the ticket — so
 * the parent is loaded with the agent's rule and a thread on a ticket they
 * cannot see is answered as one that does not exist.
 */
async function visibleSideConversation(agent: SessionAgent, sideConversationId: string) {
  if (!isUuid(sideConversationId)) return null;

  const side = await loadSideConversation(sideConversationId);
  if (!side) return null;

  const row = await loadConversation(agent, side.side.conversationId);
  return row ? { side: side.side, conversationNumber: row.conversation.number } : null;
}

export async function replyToSideConversation(
  agent: SessionAgent,
  input: { sideConversationId: string; body: string },
): Promise<SideWriteResult> {
  if (!can(agent, 'ticket.side_conversation')) {
    return { error: 'You do not have permission to write in a side conversation' };
  }

  const body = input.body.trim();
  if (!body) return { error: 'Write something first' };

  const found = await visibleSideConversation(agent, input.sideConversationId);
  if (!found) return { error: 'Side conversation not found' };
  const { side } = found;

  const parentMessageId = await lastSideMessageId(side.id);

  const inserted = await db
    .insert(sideConversationMessages)
    .values({
      sideConversationId: side.id,
      direction: 'outbound',
      authorAgentId: agent.id,
      toAddresses: side.toAddresses,
      ccAddresses: side.ccAddresses,
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
      ...(side.state === 'done'
        ? { state: 'open' as const, closedAt: null, closedByAgentId: null }
        : {}),
    })
    .where(eq(sideConversations.id, side.id));

  await enqueue(
    'send_side_email',
    { messageId },
    { priority: 10, dedupeKey: `send_side:${messageId}` },
  );

  return { error: null, conversationNumber: found.conversationNumber };
}

/** Mark a thread done, or reopen one. */
export async function setSideConversationState(
  agent: SessionAgent,
  input: { sideConversationId: string; state: string },
): Promise<SideWriteResult> {
  if (!can(agent, 'ticket.side_conversation')) {
    return { error: 'You do not have permission to change a side conversation' };
  }

  const state = input.state;
  if (state !== 'open' && state !== 'done') return { error: 'Unknown state' };

  const found = await visibleSideConversation(agent, input.sideConversationId);
  if (!found) return { error: 'Side conversation not found' };

  await db
    .update(sideConversations)
    .set(
      state === 'done'
        ? { state, closedAt: new Date(), closedByAgentId: agent.id }
        : { state, closedAt: null, closedByAgentId: null },
    )
    .where(eq(sideConversations.id, found.side.id));

  return { error: null, conversationNumber: found.conversationNumber };
}

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

/**
 * The customer's message, as the hub will see it quoted.
 *
 * Scoped by conversation id as well as message id: the anchor arrives from the
 * request, and a message id from another ticket must not be quotable into this
 * one's side conversation.
 */
async function quotedAnchorMessage(
  conversationId: string,
  messageId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      bodyText: messages.bodyText,
      kind: messages.kind,
      meta: messages.meta,
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
  // Nor is a reaction anything they wrote: the composer leaves it out, and the
  // id arrives from the request.
  if (isReaction(message.meta)) return null;

  return quoteAnchor(message.contactName, message.bodyText, message.createdAt);
}
