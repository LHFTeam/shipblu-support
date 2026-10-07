import { and, eq, gt, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  automationRules,
  cannedResponses,
  conversationEvents,
  conversationWatchers,
  conversations,
  contacts,
  ticketForms,
  ticketStatuses,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { textToHtml } from '@/lib/html/sanitize';
import { scheduleSurvey } from '@/lib/csat';
import { resolveLocale } from '@/lib/tickets/canned';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
import { requesterLocale } from '@/lib/tickets/locale';
import { automatedReplyBlocked, deliverAutomatedReply } from '@/lib/tickets/outbound';
import { matches } from '@/lib/rules/conditions';
import { conversationFacts } from '@/lib/rules/facts';
import { onGroupChanged, onStatusChanged } from '@/lib/sla';
import { parseActions, type Action } from './actions';
import { logger } from '@/lib/log';

const log = logger('automations');

/**
 * Automation rules — Freshdesk's Dispatch'r, Observer and Supervisor in one
 * table, distinguished by their trigger.
 *
 * Rules run in `position` order and a rule with `stop_processing` ends the run
 * for that ticket, which is the behaviour the team already relies on: the
 * ordering is how you say "if this is spam, do that and nothing else".
 *
 * Actions write to the ticket directly and never re-enter this module, so an
 * automation that changes a ticket cannot trigger another automation. Rule
 * chains that trigger each other are the classic way an automation engine
 * becomes an infinite loop that sends a customer four hundred emails.
 */

export type Trigger = 'on_create' | 'on_update' | 'time_based';

type Rule = {
  id: string;
  name: string;
  conditions: unknown;
  actions: unknown;
  position: number;
  stopProcessing: boolean;
};

async function activeRules(trigger: Trigger): Promise<Rule[]> {
  return db
    .select({
      id: automationRules.id,
      name: automationRules.name,
      conditions: automationRules.conditions,
      actions: automationRules.actions,
      position: automationRules.position,
      stopProcessing: automationRules.stopProcessing,
    })
    .from(automationRules)
    .where(and(eq(automationRules.trigger, trigger), eq(automationRules.isActive, true)))
    .orderBy(automationRules.position);
}

type TicketRow = {
  conversation: typeof conversations.$inferSelect;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  requesterEmail: string | null;
  formSlug: string | null;
};

async function loadTicket(conversationId: string): Promise<TicketRow | null> {
  const rows = await db
    .select({
      conversation: conversations,
      statusCategory: ticketStatuses.category,
      requesterEmail: contacts.primaryEmail,
      formSlug: ticketForms.slug,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(ticketForms, eq(ticketForms.id, conversations.formId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Runs every rule for one trigger against one ticket.
 *
 * Best-effort, like the SLA hooks: an automation that throws must not take the
 * customer's message down with it.
 */
export async function runAutomations(
  trigger: Exclude<Trigger, 'time_based'>,
  conversationId: string,
): Promise<number> {
  try {
    const rules = await activeRules(trigger);
    if (rules.length === 0) return 0;

    const ticket = await loadTicket(conversationId);
    if (!ticket) return 0;

    return await applyRules(rules, ticket);
  } catch (error) {
    log.error(`${trigger} failed on ${conversationId}`, error);
    return 0;
  }
}

/** Shared by the trigger hooks and the time-based sweep. */
export async function applyRules(
  rules: Rule[],
  ticket: TicketRow,
  now = new Date(),
): Promise<number> {
  const facts = conversationFacts(ticket, now);
  let applied = 0;

  for (const rule of rules) {
    if (!matches(rule.conditions, facts)) continue;

    const actions = parseActions(rule.actions);
    for (const action of actions) {
      try {
        await applyAction(action, ticket, rule.name);
      } catch (error) {
        // Isolated per action: a rule that assigns, tags and replies should not
        // lose the assignment because the tag write failed. Loud, though — this
        // is a rule that is not doing what its author asked for.
        log.error(`"${rule.name}" could not apply ${action.type}`, error);
      }
    }

    await db.update(automationRules).set({ lastRunAt: now }).where(eq(automationRules.id, rule.id));

    applied += 1;
    if (rule.stopProcessing) break;
  }

  return applied;
}

/**
 * A `text[]` literal with one bound parameter per element.
 *
 * Interpolating the JavaScript array directly binds it as a single scalar and
 * Postgres rejects it as a malformed array literal, so the tag actions have to
 * spell the array out. One parameter per tag keeps it injection-safe.
 */
function textArray(values: string[]): SQL {
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

async function applyAction(action: Action, ticket: TicketRow, ruleName: string): Promise<void> {
  const conversationId = ticket.conversation.id;

  const record = (type: string, data: Record<string, unknown>) =>
    db.insert(conversationEvents).values({
      conversationId,
      type,
      // No actor agent: the timeline says which rule did it, so "why is this
      // ticket assigned to me?" has an answer that names the rule.
      actorLabel: `automation:${ruleName}`,
      data,
    });

  switch (action.type) {
    case 'set_priority':
      await db
        .update(conversations)
        .set({ priority: action.value })
        .where(eq(conversations.id, conversationId));
      await record('priority_changed', { to: action.value });
      return;

    case 'set_status': {
      const rows = await db
        .select({
          id: ticketStatuses.id,
          name: ticketStatuses.name,
          stopsSlaClock: ticketStatuses.stopsSlaClock,
        })
        .from(ticketStatuses)
        .where(eq(ticketStatuses.category, action.category))
        .orderBy(ticketStatuses.position)
        .limit(1);

      const status = rows[0];
      if (!status) return;

      await db
        .update(conversations)
        .set({
          statusId: status.id,
          resolvedAt: action.category === 'resolved' ? new Date() : null,
          // Explicitly nobody, not "leave whoever was there". A rule closing a
          // ticket that an agent had resolved earlier owns this resolution, so
          // if the customer comes back it must not land on that agent's reopen
          // rate — they are not the reason it was closed this time.
          ...(action.category === 'resolved' ? { resolvedByAgentId: null } : {}),
          closedAt: action.category === 'closed' ? new Date() : null,
        })
        .where(eq(conversations.id, conversationId));

      await record('status_changed', { to: status.name, category: action.category });
      // The SLA clock has to hear about this the same way it hears about an
      // agent doing it by hand, or an automation that parks tickets in Pending
      // would quietly stop every clock without recording the pause.
      await onStatusChanged(conversationId, status.stopsSlaClock);
      // A rule that resolves a ticket should survey the customer exactly as an
      // agent resolving it by hand does.
      if (action.category === 'resolved') await scheduleSurvey(conversationId);
      return;
    }

    case 'assign_agent':
      await db
        .update(conversations)
        .set({
          assigneeAgentId: action.agentId,
          assignedAt: action.agentId ? new Date() : null,
        })
        .where(eq(conversations.id, conversationId));
      await record(action.agentId ? 'assigned' : 'unassigned', { to: action.agentId });
      return;

    case 'assign_group':
      await db
        .update(conversations)
        .set({ groupId: action.groupId })
        .where(eq(conversations.id, conversationId));
      await record('group_changed', { to: action.groupId });
      // The new group may work different hours, in which case the clocks move.
      // A no-op on a brand new ticket, whose SLA has not been applied yet.
      await onGroupChanged(conversationId);
      return;

    case 'auto_assign': {
      // Writes the ticket itself and does not come back through this engine, in
      // keeping with the rule at the top of this file: an automation that
      // triggered an automation is how four hundred emails reach one customer.
      const groupChanged =
        action.groupId !== null && action.groupId !== ticket.conversation.groupId;

      await assignConversation(conversationId, {
        groupId: action.groupId,
        strategy: action.strategy === 'group_default' ? undefined : action.strategy,
        actorLabel: `automation:${ruleName}`,
      });

      // The SLA counts against the group's calendar, so a rule that moved the
      // ticket has moved its due dates too — whether or not anybody was free to
      // take it.
      if (groupChanged) await onGroupChanged(conversationId);
      return;
    }

    case 'add_tags': {
      // Merged in SQL rather than read-modify-write, so two rules tagging the
      // same ticket in the same run cannot lose one another's tag.
      await db
        .update(conversations)
        .set({
          tags: sql`(select array(select distinct unnest(${conversations.tags} || ${textArray(action.tags)})))`,
        })
        .where(eq(conversations.id, conversationId));
      await record('tagged', { added: action.tags });
      return;
    }

    case 'remove_tags':
      await db
        .update(conversations)
        .set({
          tags: sql`(select array(select unnest(${conversations.tags}) except select unnest(${textArray(action.tags)})))`,
        })
        .where(eq(conversations.id, conversationId));
      await record('untagged', { removed: action.tags });
      return;

    case 'add_watchers':
      await db
        .insert(conversationWatchers)
        .values(action.agentIds.map((agentId) => ({ conversationId, agentId })))
        .onConflictDoNothing();
      await record('watchers_added', { agentIds: action.agentIds });
      return;

    case 'mark_spam':
      await db
        .update(conversations)
        .set({ isSpam: true })
        .where(eq(conversations.id, conversationId));
      await record('marked_spam', {});
      return;

    case 'send_reply':
      await sendCannedReply(action.cannedResponseId, ticket, ruleName);
      return;
  }
}

/**
 * The auto-acknowledgement: a canned response sent as the ticket's reply.
 *
 * Written here rather than through the console action because that path is
 * built around an agent — it authorises a session, attributes the message and
 * revalidates their page. What the two share is the important part, and it is
 * in the database: an outbound message row plus a queued send, so an automated
 * reply is delivered, retried and shown on the timeline exactly like a human's.
 */
/**
 * Whether this rule has already written to this ticket since the customer last did.
 *
 * A time-based rule is re-evaluated every fifteen minutes and nothing in the
 * engine remembers that it ran: `applyRules` keeps no per-ticket record and
 * `lastRunAt` is rule-global. So a rule whose condition only a person can clear
 * — "first response overdue", the obvious way to write a chase — sends the same
 * message four times an hour until somebody opens the ticket. That is the loop
 * this module opens by warning about, and the reply is the action that has to
 * stop; the conditions are shared with rules that escalate rather than send,
 * and those neither reach the customer nor need stopping.
 *
 * Since the customer last wrote, rather than once for good, because a chase is
 * about silence: once they answer, the ticket has gone quiet again for a new
 * reason and the same rule may legitimately chase it again. `lastCustomerMessageAt`
 * null means they never wrote, so any reply already sent is the only one owed.
 *
 * The rule's own name, so two rules that both reply do not silence each other —
 * an acknowledgement on create and a chase three days later are different
 * messages about different things.
 */
async function alreadyReplied(
  conversation: typeof conversations.$inferSelect,
  ruleName: string,
): Promise<boolean> {
  const since = conversation.lastCustomerMessageAt;

  const rows = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, conversation.id),
        eq(conversationEvents.type, 'auto_replied'),
        eq(conversationEvents.actorLabel, `automation:${ruleName}`),
        ...(since ? [gt(conversationEvents.createdAt, since)] : []),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

async function sendCannedReply(
  cannedResponseId: string,
  ticket: TicketRow,
  ruleName: string,
): Promise<void> {
  const conversation = ticket.conversation;

  const rows = await db
    .select({
      bodyHtmlAr: cannedResponses.bodyHtmlAr,
      bodyTextAr: cannedResponses.bodyTextAr,
      bodyHtmlEn: cannedResponses.bodyHtmlEn,
      bodyTextEn: cannedResponses.bodyTextEn,
    })
    .from(cannedResponses)
    .where(eq(cannedResponses.id, cannedResponseId))
    .limit(1);

  const canned = rows[0];
  if (!canned) {
    log.warn(`"${ruleName}" references a canned response that is gone`);
    return;
  }

  // A rule cannot reopen a closed messaging window on any of the three channels
  // that have one, and skipping is the only honest option: attempting it would
  // fail at Meta and leave a permanently failed message on the customer's
  // timeline. This engine is the reason the guard has to exist at all — it runs
  // from a cron every fifteen minutes, so a rule that chases silence reaches the
  // customer days after they last wrote, which is exactly the far side of the
  // window.
  const blocked = automatedReplyBlocked(conversation);
  if (blocked) {
    log.warn(`"${ruleName}" skipped a reply: ${blocked}`);
    return;
  }

  if (await alreadyReplied(conversation, ruleName)) {
    log.warn(`"${ruleName}" skipped a reply: it has already sent one`);
    return;
  }

  /*
    Which language this response goes out in.

    A rule names a response, not a language: the same rule fires for the Arabic
    and the English half of the queue, and picking at author time would make an
    admin choose one of their customers to answer wrongly. So it is decided per
    ticket, off the requester, by the one function the out-of-hours
    acknowledgement uses — two automated messages disagreeing about what
    language somebody reads is the failure that would be hardest to notice.

    Falling back to the language the response *was* written in, rather than
    sending nothing: the alternative is a rule that silently stops firing for
    half the queue on the day somebody adds a response in one language.
  */
  const locale = await requesterLocale(conversation.id);
  const body = { ar: canned.bodyTextAr, en: canned.bodyTextEn };
  const chosen = resolveLocale(body, locale);

  if (!chosen) {
    log.warn(`"${ruleName}" references a canned response with no body`);
    return;
  }

  const bodyText = body[chosen];

  // Derived from the text when the stored HTML is blank, rather than handed to
  // the mailer as it is. `saveCannedResponse` writes the pair together so the
  // two cannot drift through the console — but the language was chosen on the
  // text alone, and a row whose text survived a backfill or a hand-written
  // UPDATE and whose HTML did not would otherwise send a customer an empty
  // email while the WhatsApp copy of the same reply read correctly.
  const storedHtml = chosen === 'ar' ? canned.bodyHtmlAr : canned.bodyHtmlEn;
  const bodyHtml = storedHtml.trim() ? storedHtml : textToHtml(bodyText);

  await deliverAutomatedReply({
    conversationId: conversation.id,
    channel: conversation.channel,
    requesterEmail: ticket.requesterEmail,
    bodyText,
    bodyHtml,
    actorLabel: `automation:${ruleName}`,
    eventType: 'auto_replied',
    meta: { automation: ruleName },
  });

  // The rule sent this without an agent writing it. It must remain visibly
  // unanswered and its first-response clock must keep running, or a rule that
  // acknowledges every new ticket turns the human-response metric into the
  // automation's response time and can satisfy every target by itself.

  // Not counted in `usage_count`, for the same reason. The column, and its
  // per-language split, say which responses the *agents* reach for, and a rule
  // sends its response to every ticket it matches: one acknowledgement rule
  // would outrank everything the team chose by hand and bury the signal the
  // column exists to carry. This was counted until 2026-10-07; the team asked
  // for it not to be, and production had never sent one by then.
}

/**
 * The population the time-based sweep considers: everything not yet closed.
 *
 * Resolved is in scope because closing a ticket is itself a time-based rule —
 * the awaiting-confirmation window has to expire somewhere, and a sweep that
 * only saw open and pending could never be the thing that ends it. Closed is
 * excluded because it is terminal: a rule cannot act on a ticket it can no
 * longer change the meaning of, and leaving closed in would grow this scan by
 * the whole archive to no purpose.
 *
 * Spam is excluded because acting on it is how an automation ends up replying to
 * a bounce loop. Read-only channels are excluded because a rule that fires on
 * "no reply in 4 hours" would otherwise send an auto-reply into a conversation
 * the customer is having with a bot.
 */
export async function liveTickets(limit: number): Promise<TicketRow[]> {
  return db
    .select({
      conversation: conversations,
      statusCategory: ticketStatuses.category,
      requesterEmail: contacts.primaryEmail,
      formSlug: ticketForms.slug,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(ticketForms, eq(ticketForms.id, conversations.formId))
    .where(
      and(
        isNull(conversations.deletedAt),
        eq(conversations.isSpam, false),
        notInArray(conversations.channel, readOnlyChannels()),
        inArray(ticketStatuses.category, ['open', 'pending', 'resolved']),
      ),
    )
    .orderBy(conversations.lastMessageAt)
    .limit(limit);
}

export { activeRules };
