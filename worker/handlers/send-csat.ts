import { and, eq, exists, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, conversationEvents, conversations, messages, ticketStatuses } from '@/db/schema';
import { recordSkip, sendSurvey } from '@/lib/csat';
import { surveyEmail } from '@/lib/csat/email';
import { wordingForTicket } from '@/lib/csat/rules';
import { surveyText } from '@/lib/csat/wording';
import { decideSurvey, type SurveyTrigger } from '@/lib/csat/decision';
import { readCsatSettings } from '@/lib/csat/settings';
import { rootCommentId } from '@/lib/meta/comments';
import { isReadOnlyChannel } from '@/lib/tickets/channel-policy';
import { requesterLocale } from '@/lib/tickets/locale';
import { notReaction } from '@/lib/tickets/not-reaction';
import { automatedReplyBlocked, lacksEmailRecipient, sendsByEmail } from '@/lib/tickets/outbound';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';

const log = logger('send_csat');

/**
 * Sends one satisfaction survey, a while after a ticket was resolved.
 *
 * Enqueued per ticket rather than swept: the trigger is a specific event with a
 * specific delay, and a queued job with a `runAt` says that directly.
 *
 * Everything it checks is read here rather than at enqueue time, because the
 * delay is long enough for all of it to have changed — and every outcome is a
 * row (`lib/csat`), so "why was this customer not asked?" is answered on the
 * ticket rather than in this log. The decision itself is `decideSurvey`, pure
 * and tested; this reads what it needs and writes what it decided.
 *
 * The job runs at least once, not exactly once (AGENTS.md, _The worker is a
 * pool_), and two jobs for one ticket can run together. `sendSurvey` is where
 * that is settled: under a lock on the ticket, a second survey inside the
 * window is refused and nothing is written, and the survey, its message and
 * the job that carries it commit together, so a run stopped at any point
 * either sent the survey or wrote nothing.
 */

export async function sendCsat(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'send_csat');
  const { conversationId } = payload;
  // Rows queued before the trigger existed were an agent's resolve.
  const trigger: SurveyTrigger = payload.trigger ?? 'agent';

  const rows = await db
    .select({
      id: conversations.id,
      number: conversations.number,
      channel: conversations.channel,
      isSpam: conversations.isSpam,
      deletedAt: conversations.deletedAt,
      mergedIntoId: conversations.mergedIntoId,
      csatSuppressed: conversations.csatSuppressed,
      assigneeAgentId: conversations.assigneeAgentId,
      resolvedByRule: resolvedByRule(),
      groupId: conversations.groupId,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      // Read by `automatedReplyBlocked`, to tell a comment ticket from a DM.
      externalId: conversations.externalId,
      statusCategory: ticketStatuses.category,
      contactEmail: contacts.primaryEmail,
      contactLocale: contacts.locale,
      // Whether the customer sent anything at all — a reaction aside, which is
      // an acknowledgement of an answer rather than taking part.
      hasCustomerMessage: exists(
        db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversations.id),
              eq(messages.direction, 'inbound'),
              eq(messages.kind, 'reply'),
              notReaction(),
            ),
          ),
      ),
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const ticket = rows[0];
  if (!ticket) return;

  // A read that fails fails the job, so the queue retries: "off" written on
  // the ticket would outlive the hiccup.
  const settings = await readCsatSettings();
  const isMeta = ticket.channel === 'facebook' || ticket.channel === 'instagram';

  const decision = decideSurvey(
    {
      channel: ticket.channel,
      statusCategory: ticket.statusCategory,
      deletedAt: ticket.deletedAt,
      isSpam: ticket.isSpam,
      mergedIntoId: ticket.mergedIntoId,
      hasCustomerMessage: Boolean(ticket.hasCustomerMessage),
      suppressed: ticket.csatSuppressed,
      resolvedByRule: ticket.resolvedByRule,
      lacksRecipient: lacksEmailRecipient(ticket.channel, ticket.contactEmail),
      commentThread: rootCommentId(ticket.externalId) !== null,
      // The third automated sender, through the same guard as the other two:
      // past 24 hours only `HUMAN_AGENT` sends on these platforms, and that tag
      // is reserved for a message a person wrote.
      metaWindowOpen: isMeta ? automatedReplyBlocked(ticket) === null : false,
      readOnly: isReadOnlyChannel(ticket.channel),
      byEmail: sendsByEmail(ticket.channel),
    },
    settings,
  );

  const snapshot = {
    agentId: ticket.assigneeAgentId,
    groupId: ticket.groupId,
    channel: ticket.channel,
  };

  if (decision.kind === 'drop') return;

  // An agent who pressed "Send now" is owed an answer on the ticket even when
  // it is the same one the scheduled run gave an hour ago: the sidebar waits
  // for a new decision to land, and a repeat folded into the earlier row is
  // a "queued" line that never clears.
  const answer = { repeat: trigger === 'manual' };

  if (decision.kind === 'skip') {
    await recordSkip(conversationId, decision.reason, snapshot, answer);
    log.info(`#${ticket.number}: no survey — ${decision.reason}`);
    return;
  }

  // The customer's own words, not `contacts.locale` alone, which nothing
  // writes: read off the column, every survey went out in English (§6). The
  // one door every unattended sender uses, handed the contact's column it
  // already read so it is not read twice.
  const locale = await requesterLocale(conversationId, ticket.contactLocale);

  // The admin's wording for this ticket's group and channel, or the built-in.
  const { ruleId, wording } = await wordingForTicket(
    { groupId: ticket.groupId, channel: ticket.channel },
    locale,
  );

  const sent = await sendSurvey({
    conversationId,
    locale,
    delivery: decision.delivery,
    snapshot,
    resurveyAfterDays: settings.resurveyAfterDays,
    ruleId,
    requesterEmail: ticket.contactEmail,
    body: (url) => {
      if (decision.delivery === 'email_link') {
        const email = surveyEmail(wording, locale, url);
        return { text: email.text, html: email.html };
      }
      return { text: surveyText(wording, url), html: null };
    },
  });

  if (sent.kind === 'drop') return;

  if (sent.kind === 'skip') {
    // The ticket changed under the job between its read and the locked write.
    await recordSkip(conversationId, sent.reason, snapshot, answer);
    log.info(`#${ticket.number}: no survey — ${sent.reason}`);
    return;
  }

  if (sent.kind === 'surveyed') {
    // Surveyed inside the window already, by an earlier run or by the other of
    // two jobs for one ticket, whose carrier committed with it. A scheduled
    // duplicate writes nothing: the survey it would sit on top of is the
    // answer. An agent who pressed "Send now" is owed one, on the ticket.
    if (trigger === 'manual') {
      await recordSkip(conversationId, 'recently_surveyed', snapshot, answer);
      log.info(`#${ticket.number}: surveyed inside the window already — told the agent`);
    } else {
      log.info(`#${ticket.number}: surveyed inside the window already — nothing to do`);
    }
    return;
  }

  log.info(`surveyed #${ticket.number} on ${ticket.channel} in ${locale}`);
}

/**
 * Whether a rule, not a person, ended the ticket's latest open stretch.
 *
 * Read off the timeline rather than off `resolved_by_agent_id`, which is
 * null for more than a rule's resolve: an agent who closed a ticket straight
 * from Open never stamps it (`changeStatus` writes it only on a resolve), and
 * so was refused as "a rule resolved it" whenever rule-resolved tickets are
 * not surveyed. A rule's status change carries no agent and an
 * `automation:<rule>` label (`lib/automations`); a person's carries them.
 *
 * Since the ticket was last open, the newest move into a resolved status,
 * and only with none of those the first move into a closed one. Resolving is
 * what a resolution is, and closing is tidying after it: an agent's resolve
 * that the three-day rule then closes is still the agent's, a rule's resolve
 * that an agent closes is still the rule's — and a rule's resolve that an
 * agent resolves again, answering with "reply and resolve" or moving it to
 * another resolved status, is the agent's, who did the work the survey asks
 * about (`changeStatus` writes the move and schedules the survey either way).
 * "Last open" is the newest reopen, or move back to an open or pending
 * status. A ticket with no such event — older than the timeline's status
 * events, or written straight into a done state — falls back to the column,
 * which is right for every resolve a rule ever made.
 */
function resolvedByRule() {
  const lastOpen = sql`(
    select max(${conversationEvents.createdAt})
    from ${conversationEvents}
    where ${conversationEvents.conversationId} = ${conversations.id}
      and (
        ${conversationEvents.type} = 'reopened'
        or (
          ${conversationEvents.type} = 'status_changed'
          and ${conversationEvents.data}->>'category' in ('open', 'pending')
        )
      )
  )`;

  return sql<boolean>`coalesce(
    (
      select ${conversationEvents.actorAgentId} is null
        and coalesce(${conversationEvents.actorLabel}, '') like 'automation:%'
      from ${conversationEvents}
      where ${conversationEvents.conversationId} = ${conversations.id}
        and ${conversationEvents.type} = 'status_changed'
        and ${conversationEvents.data}->>'category' in ('resolved', 'closed')
        and ${conversationEvents.createdAt} > coalesce(${lastOpen}, '-infinity'::timestamptz)
      order by
        ${conversationEvents.data}->>'category' = 'resolved' desc,
        case when ${conversationEvents.data}->>'category' = 'resolved'
          then ${conversationEvents.createdAt} end desc nulls last,
        ${conversationEvents.createdAt} asc
      limit 1
    ),
    ${conversations.resolvedByAgentId} is null and ${ticketStatuses.category} = 'resolved'
  )`;
}
