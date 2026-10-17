import { and, between, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, conversationEvents, conversations, csatSurveys, groups } from '@/db/schema';
import { LOW_RATING_MAX } from '@/lib/csat/limits';
import { lowRatingEmail, lowRatingRecipients, namesAgentTo } from '@/lib/csat/low-rating';
import { readCsatSettings } from '@/lib/csat/settings';
import { appUrl } from '@/lib/env';
import { logger } from '@/lib/log';
import { enqueue, type ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { surveyedConversation } from '@/lib/reports/rollup';

const log = logger('notify_low_rating');

/** Behind every reply: a supervisor's alert waits for no customer. */
const EMAIL_PRIORITY = 60;

/**
 * Tells the supervisors that a customer rated a ticket 1 or 2.
 *
 * Queued by `recordAnswer` in the transaction that records the rating, so it
 * exists exactly when a low answer does; it decides the rest when it runs.
 * The switch is read now, so turning alerts off stops those already queued.
 * The ticket is held to the report's filter (`surveyedConversation()`) — the
 * one the inbox's "Rated 1–2" view lists by — once to find it and again under
 * its lock, so an alert is never queued for a ticket deleted, marked spam or
 * purged by the time it is, and the email and the view mean the same
 * tickets. An email already queued still goes.
 *
 * One email job per recipient rather than one send here, so a refused address
 * retries alone instead of mailing everybody else again. They are queued on
 * the transaction that writes the timeline's `csat_low_rating` event, which
 * names who was to be told, under the ticket's lock: a second run of this job — the
 * worker runs a job at least once — waits for the first and finds its event.
 * The event is written with nobody to tell too, so a ticket whose 1 reached
 * nobody says so rather than leaving a supervisor to wonder why.
 */
export async function notifyLowRating(job: ClaimedJob): Promise<void> {
  const { surveyId } = parseJobPayload(job, 'notify_low_rating');

  const settings = await readCsatSettings();
  if (!settings.lowRatingAlerts) {
    log.info(`${surveyId}: alerts are off — nobody told`);
    return;
  }

  const [survey] = await db
    .select({
      conversationId: csatSurveys.conversationId,
      rating: csatSurveys.rating,
      number: conversations.number,
      agentName: agents.name,
      groupName: groups.name,
    })
    .from(csatSurveys)
    .innerJoin(
      conversations,
      and(eq(conversations.id, csatSurveys.conversationId), surveyedConversation()),
    )
    .leftJoin(agents, eq(agents.id, csatSurveys.agentId))
    .leftJoin(groups, eq(groups.id, csatSurveys.groupId))
    .where(
      and(
        eq(csatSurveys.id, surveyId),
        eq(csatSurveys.status, 'answered'),
        between(csatSurveys.rating, 1, LOW_RATING_MAX),
      ),
    )
    .limit(1);

  // Purged, deleted, spam, or not a low answer — the last only by hand, since
  // `recordAnswer` queues this for nothing else. Each is a ticket nobody is
  // asked to follow up, not a fault to retry.
  if (!survey || survey.rating === null) {
    log.info(`${surveyId}: no low rating on a ticket the report counts — nobody told`);
    return;
  }

  const candidates = await db
    .select({
      id: agents.id,
      email: agents.email,
      role: agents.role,
      permissions: agents.permissions,
      isActive: agents.isActive,
      activated: sql<boolean>`${agents.passwordHash} is not null`,
    })
    .from(agents)
    .where(eq(agents.isActive, true));
  const recipients = lowRatingRecipients(candidates);

  const alert = {
    number: survey.number,
    rating: survey.rating,
    agentName: survey.agentName,
    groupName: survey.groupName,
    url: `${appUrl()}/inbox/${survey.number}`,
  };
  const naming = lowRatingEmail({ ...alert, namesAgent: true });
  const unnamed = lowRatingEmail({ ...alert, namesAgent: false });

  const told = await db.transaction(async (tx) => {
    // The filter again, against the row this waited for: Postgres re-reads a
    // locked row's predicate, so a delete, a spam mark or a purge that
    // committed in between leaves nothing to hold.
    const [held] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, survey.conversationId), surveyedConversation()))
      .for('update');
    if (!held) return 'gone' as const;

    const already = await tx
      .select({ id: conversationEvents.id })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, survey.conversationId),
          eq(conversationEvents.type, 'csat_low_rating'),
          sql`${conversationEvents.data}->>'surveyId' = ${surveyId}`,
        ),
      )
      .limit(1);
    if (already[0]) return null;

    await tx.insert(conversationEvents).values({
      conversationId: survey.conversationId,
      type: 'csat_low_rating',
      actorLabel: 'csat',
      data: { surveyId, rating: survey.rating, agentIds: recipients.map((agent) => agent.id) },
    });

    for (const agent of recipients) {
      await enqueue(
        'send_notification_email',
        { to: agent.email, ...(namesAgentTo(agent) ? naming : unnamed) },
        { on: tx, priority: EMAIL_PRIORITY },
      );
    }

    return recipients.length;
  });

  if (told === 'gone') {
    log.info(`#${survey.number}: the ticket went while this waited — nobody told`);
    return;
  }
  if (told === null) {
    log.info(`#${survey.number}: the ${survey.rating} was already reported — nothing to do`);
    return;
  }
  log.info(
    `#${survey.number}: rated ${survey.rating} — ${told === 0 ? 'nobody to email' : `queued ${told} ${told === 1 ? 'email' : 'emails'}`}`,
  );
}
