import { and, eq, gt, inArray, isNull, ne, notInArray, sql, type SQL } from 'drizzle-orm';
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
import { afterHoldEnded } from '@/lib/routing/after-hold';
import { endHold } from '@/lib/routing/end-hold';
import { textToHtml } from '@/lib/html/sanitize';
import { scheduleSurvey, suppressSurveyByRule } from '@/lib/csat';
import { resolveLocale } from '@/lib/tickets/canned';
import { isCommentTicket, readOnlyChannels } from '@/lib/tickets/channel-policy';
import { requesterLocale } from '@/lib/tickets/locale';
import { automatedReplyBlocked, deliverAutomatedReply } from '@/lib/tickets/outbound';
import { matches } from '@/lib/rules/conditions';
import { conversationFacts } from '@/lib/rules/facts';
import { setConversationCategory } from '@/lib/categories/write';
import { afterRoutingChanged, onPriorityChanged, onStatusChanged } from '@/lib/sla';
import { CHANGE_STAMP } from '@/lib/tickets/change-stamp';
import { moveToGroupIfElsewhere } from '@/lib/tickets/move-group';
import { resolveStamp } from '@/lib/tickets/resolve-stamp';
import { reopenWithOwner } from '@/lib/whatsapp/number-owner';
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

    // An `on_create` pass runs before `applySlaOnCreate`, which reads the
    // category and group the pass left, so it chooses no policy of its own.
    return await applyRules(rules, ticket, new Date(), { slaApplied: trigger !== 'on_create' });
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
  { slaApplied = true }: { slaApplied?: boolean } = {},
): Promise<number> {
  const facts = conversationFacts(ticket, now);
  const pass: Pass = {
    surveyOwed: false,
    categoryChanged: false,
    groupMoved: false,
    endedHold: false,
  };
  let applied = 0;

  try {
    for (const rule of rules) {
      if (!matches(rule.conditions, facts)) continue;

      for (const action of parseActions(rule.actions)) {
        try {
          await applyAction(action, ticket, rule.name, pass);
        } catch (error) {
          // Isolated per action: a rule that assigns, tags and replies should not
          // lose the assignment because the tag write failed. Loud, though — this
          // is a rule that is not doing what its author asked for.
          log.error(`"${rule.name}" could not apply ${action.type}`, error);
        }
      }

      await db
        .update(automationRules)
        .set({ lastRunAt: now })
        .where(eq(automationRules.id, rule.id));

      applied += 1;
      if (rule.stopProcessing) break;
    }
  } finally {
    // Once the pass is over, so a `suppress_survey` anywhere in it — later in
    // the resolving rule, or in a later rule — has set the flag before the job
    // exists: queued at the resolve, with the delay at 0 the worker could send
    // it before the suppression ran. And once, however many rules resolved.
    // In a `finally`, because the resolve has committed: a pass that throws
    // after it (the `lastRunAt` write above is not isolated) must not take
    // the ticket's survey with it, and `scheduleSurvey` throws nothing that
    // could hide the error.
    if (pass.surveyOwed) await scheduleSurvey(ticket.conversation.id, 'rule');
    // Once, from the ticket as the whole pass left it, so a rule that files a
    // ticket and another that moves it choose one policy between them and the
    // clocks move once, from the group the pass left it in. In the `finally`
    // for the survey's reason: the writes have committed. Not on an `on_create`
    // pass: `applySlaOnCreate` runs after it and reads the category and group
    // it left, and the ticket has no clocks yet for a move to re-time.
    if (slaApplied) {
      await afterRoutingChanged(ticket.conversation.id, {
        category: pass.categoryChanged,
        group: pass.groupMoved,
      });
      // A rule decided where a held ticket goes (`endHold`), so what the hold
      // kept back is owed now, from the group the whole pass left it in. Not
      // after an `on_create` pass, which the creation pass follows with both.
      if (pass.endedHold) await afterHoldEnded(ticket.conversation.id);
    }
  }

  return applied;
}

/** What one pass over the rules owes once every rule in it has run. */
type Pass = {
  surveyOwed: boolean;
  /**
   * A rule changed the ticket's category or moved its group — what
   * `afterRoutingChanged` takes once the pass is over: the policy chosen again
   * if nobody has answered yet, and the clocks re-timed on a new group's hours.
   */
  categoryChanged: boolean;
  groupMoved: boolean;
  /** A rule ended a routing hold, which owes the assignment and the held reply. */
  endedHold: boolean;
};

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

async function applyAction(
  action: Action,
  ticket: TicketRow,
  ruleName: string,
  pass: Pass,
): Promise<void> {
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
      // The column and its event in one transaction, as the console writes
      // them. The priority classifier decides whose priority a ticket carries
      // under the row lock, from the column and the `priority_changed` events
      // together; between two autocommits it could see a rule's `medium` with no
      // event owning it, take it for the default, and write over the rule's
      // choice — with the rule's event then landing after, naming the rule for a
      // value the column no longer held. The event is stamped once the update
      // holds the lock, for the reason `CHANGE_STAMP` gives.
      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ priority: action.value })
          .where(eq(conversations.id, conversationId));
        await tx.insert(conversationEvents).values({
          conversationId,
          type: 'priority_changed',
          actorLabel: `automation:${ruleName}`,
          createdAt: CHANGE_STAMP,
          data: { to: action.value },
        });
      });
      // An on_create rule runs before the SLA is applied, so this is a no-op
      // there and `applySlaOnCreate` reads the raised priority itself. An
      // on_update or time rule escalating a live ticket is the case it is for.
      await onPriorityChanged(conversationId);
      return;

    case 'set_category': {
      const write = await setConversationCategory(conversationId, action.categoryId, {
        label: `automation:${ruleName}`,
      });
      if (write.outcome === 'changed') pass.categoryChanged = true;
      // Said, because it is a rule not doing what its author asked for: the
      // category it names was retired, or deleted from under it.
      if (write.outcome === 'retired_category' || write.outcome === 'unknown_category') {
        log.warn(`"${ruleName}" names a category that is ${write.outcome.split('_')[0]}`);
      }
      return;
    }

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

      // Through `reopenWithOwner`, as every status writer is, so a rule moving
      // a WhatsApp ticket back out of resolved or closed takes its number's
      // current owner; in a transaction because the channel's lock has to be
      // held across the status write for a handover to see one or the other.
      await db.transaction((tx) =>
        reopenWithOwner(tx, conversationId, action.category, 'reopened_by_status', async () => {
          await tx
            .update(conversations)
            .set({
              statusId: status.id,
              ...resolveStamp(action.category),
              // Explicitly nobody, not "leave whoever was there". A rule resolving
              // a ticket that an agent had resolved earlier owns this resolution,
              // so if the customer comes back it must not land on that agent's
              // reopen rate — they are not the reason it was resolved this time.
              // A rule's close leaves it: the resolve it follows is still theirs.
              ...(action.category === 'resolved' ? { resolvedByAgentId: null } : {}),
              closedAt: action.category === 'closed' ? new Date() : null,
            })
            .where(eq(conversations.id, conversationId));
          return true;
        }),
      );

      await record('status_changed', { to: status.name, category: action.category });
      // The SLA clock has to hear about this the same way it hears about an
      // agent doing it by hand, or an automation that parks tickets in Pending
      // would quietly stop every clock without recording the pause.
      await onStatusChanged(conversationId, status.stopsSlaClock);
      // A rule that resolves a ticket should survey the customer exactly as an
      // agent resolving it by hand does — queued when the pass ends
      // (`applyRules`), so the pass's own `suppress_survey` comes first.
      if (action.category === 'resolved') pass.surveyOwed = true;
      return;
    }

    case 'assign_agent': {
      // A rule naming somebody has decided who answers a ticket held for the
      // router, so the hold ends with the assignment, in its transaction.
      const agentId = action.agentId;
      const ended = await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ assigneeAgentId: agentId, assignedAt: agentId ? new Date() : null })
          .where(eq(conversations.id, conversationId));
        return agentId
          ? endHold(tx, conversationId, 'rule', { label: `automation:${ruleName}` })
          : false;
      });
      if (ended) pass.endedHold = true;
      await record(agentId ? 'assigned' : 'unassigned', { to: agentId });
      return;
    }

    case 'assign_group': {
      // Only when it moves the ticket: a rule naming the group the ticket is
      // already in matches on every pass (`moveToGroupIfElsewhere`), and must
      // not end every routing hold on its channel. Compared against the row as
      // the move's own update finds it, and the hold ended in that transaction.
      const move = await db.transaction(async (tx) => {
        if (!(await moveToGroupIfElsewhere(conversationId, action.groupId, { executor: tx }))) {
          return null;
        }
        return {
          endedHold: await endHold(tx, conversationId, 'rule', {
            label: `automation:${ruleName}`,
          }),
        };
      });
      if (!move) return;
      if (move.endedHold) pass.endedHold = true;

      // The new group may work different hours, in which case the clocks move,
      // once the pass is over (`Pass.groupMoved`). Nothing to move on a brand
      // new ticket, whose SLA has not been applied yet. Noted before the event
      // is written: the move has committed, so a failure recording it must not
      // also lose the follow-up it owes.
      pass.groupMoved = true;
      await record('group_changed', { to: action.groupId });
      return;
    }

    case 'auto_assign': {
      // Writes the ticket itself and does not come back through this engine, in
      // keeping with the rule at the top of this file: an automation that
      // triggered an automation is how four hundred emails reach one customer.
      // The SLA counts against the group's calendar, so a rule that moved the
      // ticket has moved its due dates too — whether or not anybody was free to
      // take it. Read off what the call did rather than off the rule and the
      // ticket as the pass found it: a ticket held by somebody other than its
      // number's owner, or routed to a group deleted since, stays where it was
      // and owes nothing (`moveToGroupIfElsewhere`, for why that matters).
      // Through `routed` rather than the answer, and in a `finally`, for
      // `assign_group`'s reason: the move commits before the pick, so a pick
      // that throws must not also lose the follow-up the move owes.
      // Naming another group ends a routing hold, in the move's transaction
      // (`endsHoldAs`); naming the group the ticket is in, or none, is held
      // like any other assignment, and the rule's strategy waits with it for
      // whatever ends the hold (`recordHeldAssignment`) — a round-robin rule
      // over a group left on `manual` would otherwise assign nobody.
      const routed: { moved: boolean; endedHold?: boolean } = { moved: false };
      try {
        await assignConversation(conversationId, {
          groupId: action.groupId,
          strategy: action.strategy === 'group_default' ? undefined : action.strategy,
          actorLabel: `automation:${ruleName}`,
          routed,
          endsHoldAs: 'rule',
        });
      } finally {
        if (routed.moved) pass.groupMoved = true;
        if (routed.endedHold) pass.endedHold = true;
      }
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

    case 'suppress_survey':
      // Already off, as the pass found it: nothing to write, and no
      // transaction for a time rule matching every live ticket each sweep. A
      // stale read only skips a write the next pass makes.
      if (ticket.conversation.csatSuppressed) return;
      // Not through `record()`: the write and its event are one conditional
      // transaction, so a rule that matches every fifteen minutes writes the
      // event once, on the flip. A resolve in the same pass queues its survey
      // only once the pass is over (`applyRules`). One queued earlier — the
      // status picker's resolve, which runs `on_update` straight after — is
      // still caught, because the job reads the flag when it runs and again
      // under the ticket lock; with the survey delay at 0 it can lose that
      // race, as the agent's own toggle can. Reply-and-resolve runs no
      // `on_update`, so a rule meant to catch a resolve keys on what the
      // ticket is — its form, channel or group — on the trigger that sets it.
      if (await suppressSurveyByRule(conversationId, ruleName)) {
        log.info(`"${ruleName}" kept the survey off ${conversationId}`);
      }
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

  // Never on a public comment thread. The reply is posted under a comment where
  // anybody reading the post sees it, and nothing here knows whose comment set
  // the rule off: an `on_update` rule fires on a passer-by's reply under the
  // customer's comment as readily as on the customer's own, a time rule on
  // nobody's, and `send_meta` posts under whichever comment came in last. The
  // out-of-hours acknowledgement may answer a comment because it is handed the
  // one that triggered it (`answersRequester`); this engine is handed a ticket.
  if (isCommentTicket(conversation.channel, conversation.externalId)) {
    log.warn(`"${ruleName}" skipped a reply: a rule does not answer a public comment`);
    return;
  }

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
 * the customer is having with a bot. Imports are excluded because they are a
 * record of conversations that ended before this system saw them — a
 * WhatsApp Business app history filed resolved — and a rule closing "resolved
 * for three days" tickets would otherwise sweep six months of them on its
 * next run.
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
        ne(conversations.sourceSystem, 'import'),
        inArray(ticketStatuses.category, ['open', 'pending', 'resolved']),
      ),
    )
    .orderBy(conversations.lastMessageAt)
    .limit(limit);
}

export { activeRules };
