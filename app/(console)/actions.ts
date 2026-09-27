'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  cannedResponses,
  conversationEvents,
  conversations,
  messages,
  groups,
  ticketStatuses,
  whatsappTemplates,
} from '@/db/schema';
import { purgeConversation, type PurgeRefusal } from '@/lib/admin/purge';
import { hiddenScopeRefusal } from '@/lib/admin/purge-visibility';
import { assignConversation } from '@/lib/assignment';
import { requireAgent } from '@/lib/auth/guard';
import { text } from '@/lib/http/form-data';
import { ok, type ActionState as BaseActionState } from '@/lib/http/action-state';
import { isUuid } from '@/lib/http/uuid';
import { can } from '@/lib/auth/permissions';
import { carrierFor, sendsByEmail } from '@/lib/tickets/outbound';
import { isPriority } from '@/lib/tickets/vocabulary';
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
import { metaWindowState } from '@/lib/meta/window';
import { metaReplyTarget } from '@/lib/tickets/meta-thread';
import { isBlank } from '@/lib/tickets/custom-fields';
import { parseFieldValue } from '@/lib/tickets/custom-fields-parse';
import { getTicketField } from '@/lib/tickets/lookups';
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
