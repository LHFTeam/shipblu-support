import { recordMetaFeedback } from '@/lib/csat/meta-feedback';
import { recordAppRole } from '@/lib/meta/app-roles';
import { isMetaConnection, type MetaConnection } from '@/lib/meta/connection';
import { echoDisposition, type EchoDisposition } from '@/lib/meta/echo';
import { parseMetaWebhook } from '@/lib/meta/parse';
import {
  applyMetaInteraction,
  applyMetaReceipt,
  ingestMetaComment,
  ingestMetaEcho,
  ingestMetaMessage,
} from '@/lib/tickets/ingest-meta';
import { env } from '@/lib/env';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';

const log = logger('meta');

/**
 * The run of a delivery on which an echo that found no ticket is given up:
 * every run before it fails the delivery so the queue tries again.
 */
const ECHO_TICKET_ATTEMPTS = 4;

/**
 * Turns a stored Facebook or Instagram payload into conversations.
 *
 * One batch can carry unrelated events from different customers, so each is
 * processed independently and failures are collected: one item that throws
 * does not stop the rest. **Any failure then fails the job**, so the queue
 * runs the whole delivery again, and a delivery that keeps failing goes
 * `dead` where it can be seen.
 *
 * It used to fail only when *every* item had failed, to tell an outage from
 * one malformed comment. That dropped the item that failed beside one that
 * worked — a message, or a survey answer, lost to a dropped connection, with
 * nothing to retry it and Meta never redelivering. The rerun is safe because
 * every item type does nothing the second time:
 *
 * - a message and a comment are found by their mid or comment id, before
 *   anything is written (`ingestMetaMessage`, `ingestMetaComment`), and so is
 *   an echo filed as the team's reply (`ingestMetaEcho`), which moves the
 *   ticket's "last" columns forward only and stops a clock only for what came
 *   before it (`onAgentReply`);
 * - an interaction by its instant on the ticket (`applyMetaInteraction`);
 * - a survey answer by `recordAnswer`'s first-answer-wins, and only a first
 *   answer is thanked (`recordMetaFeedback`);
 * - a receipt moves a message forward only (`applyMetaReceipt`);
 * - an app's role by its account, app and instant (`recordAppRole`), which
 *   moves no ticket at all — its instant is read against each ticket's own.
 *
 * Instagram, delivered on both of its connections, already ran its items
 * twice; on Facebook a second run is new, which is why each item type's dedupe
 * is listed above. What a retry adds is order: the item that failed
 * now lands after siblings that are newer than it, which is why the ingest
 * moves a ticket's "last" columns and its reply clock forward only. A new
 * item type has to meet both.
 *
 * The connection travels on the row rather than being worked out here: the two
 * Instagram connections post identical bodies and are separated only by which
 * app secret verified the signature, which is known at the endpoint and nowhere
 * else. Null on anything stored before the column existed.
 */
export async function processMetaWebhook(event: {
  id: string;
  payload: unknown;
  connection: string | null;
  /** Which run of the delivery this is, from 1 (`webhook_events.attempts`). */
  attempt: number;
}): Promise<void> {
  const parsed = parseMetaWebhook(event.payload, readConnection(event.connection));

  const failures: string[] = [];
  let messages = 0;
  let comments = 0;
  let receipts = 0;
  let interactions = 0;
  let answers = 0;
  let appRoles = 0;
  let echoesFiled = 0;
  const echoesIgnored: Record<Exclude<EchoDisposition, 'file'>, number> = {
    own: 0,
    standby: 0,
    instagram: 0,
    unattributed: 0,
  };
  // Interactions that found no live ticket, or had already been recorded,
  // survey answers that recorded nothing — a second copy, an unknown survey,
  // somebody other than the requester — and echoes already filed or with no
  // ticket to file on. For the log line only; on a retry it includes what an
  // earlier attempt recorded.
  let skipped = 0;

  for (const message of parsed.messages) {
    try {
      const result = await ingestMetaMessage(message);
      messages += 1;
      log.info(
        `${message.platform} dm ${message.mid} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(`${message.mid}: ${errorMessage(error)}`);
    }
  }

  // After the messages, so a customer's message and the reply to it in one
  // batch land in that order. Only another app's reply on a thread this app
  // holds is filed (`echoDisposition`); the rest are counted by why, for the
  // log line.
  const ownAppId = env().META_APP_ID || null;
  for (const echo of parsed.echoes) {
    const disposition = echoDisposition(echo, ownAppId);
    if (disposition !== 'file') {
      echoesIgnored[disposition] += 1;
      continue;
    }
    try {
      const result = await ingestMetaEcho(echo);
      // The customer's message may still be on its way: Meta sends each event
      // in a delivery of its own, and the one opening the ticket can be
      // waiting on its retry, or running beside this one, when the reply is
      // processed. So an echo with no ticket fails the delivery while it is
      // young enough for that to be the reason — its first three runs, 10 s
      // and 50 s after the first — and is given up on the fourth, at 140 s,
      // never reaching the fifth that sends a job `dead`.
      if (result.notFiled === 'no_ticket' && event.attempt < ECHO_TICKET_ATTEMPTS) {
        failures.push(`echo ${echo.mid}: no live ticket for its customer yet`);
        continue;
      }
      if (result.filed && !result.duplicate) echoesFiled += 1;
      else skipped += 1;
      log.info(
        `${echo.platform} echo ${echo.mid} from app ${echo.appId} → ` +
          (result.filed
            ? `#${result.conversationNumber} (${result.duplicate ? 'duplicate' : "filed as the team's reply"})`
            : result.notFiled === 'predates_ticket'
              ? "not filed: older than every customer message on the customer's ticket"
              : 'not filed: no live ticket for its customer'),
      );
    } catch (error) {
      failures.push(`echo ${echo.mid}: ${errorMessage(error)}`);
    }
  }

  for (const comment of parsed.comments) {
    try {
      const result = await ingestMetaComment(comment);
      comments += 1;
      log.info(
        `${comment.platform} comment ${comment.commentId} → #${result.conversationNumber} ` +
          `(${result.duplicate ? 'duplicate' : result.createdConversation ? 'new' : 'appended'})`,
      );
    } catch (error) {
      failures.push(`comment ${comment.commentId}: ${errorMessage(error)}`);
    }
  }

  for (const interaction of parsed.interactions) {
    try {
      const applied = await applyMetaInteraction(interaction);
      if (applied) interactions += 1;
      else skipped += 1;
      log.info(
        `${interaction.platform} ${interaction.kind} from ${interaction.from} ` +
          `(${interaction.summary}) → ${applied ? 'recorded' : 'no live ticket, or already recorded'}`,
      );
    } catch (error) {
      failures.push(`${interaction.kind}: ${errorMessage(error)}`);
    }
  }

  for (const feedback of parsed.feedbacks) {
    try {
      const outcome = await recordMetaFeedback(feedback);
      if (outcome === 'recorded' || outcome === 'comment_added') answers += 1;
      else skipped += 1;
      log.info(
        `${feedback.platform} survey answer (${feedback.source}, ${feedback.rating}) ` +
          `from ${feedback.from} → ${outcome}`,
      );
    } catch (error) {
      failures.push(`survey answer for ${feedback.surveyId}: ${errorMessage(error)}`);
    }
  }

  // Logged one by one: a switch of default app changes which tickets can be
  // answered at all, and the line is how somebody finds when it happened.
  for (const role of parsed.appRoles) {
    try {
      const stored = await recordAppRole(role, event.id);
      if (stored) appRoles += 1;
      log.info(
        `${role.platform} app_roles on ${role.accountId}: app ${role.appId} is ` +
          `${role.roles.join(', ') || 'given no role'} as of ${role.at.toISOString()} → ` +
          `${stored ? 'recorded' : 'already recorded'}`,
      );
    } catch (error) {
      failures.push(`app_roles for ${role.appId}: ${errorMessage(error)}`);
    }
  }

  for (const receipt of parsed.receipts) {
    try {
      receipts += await applyMetaReceipt(receipt);
    } catch (error) {
      failures.push(`receipt: ${errorMessage(error)}`);
    }
  }

  log.info(
    `${event.id} via ${event.connection ?? 'an unrecorded connection'}: ` +
      `${messages} message(s), ${comments} comment(s), ${receipts} receipt(s), ` +
      `${interactions} interaction(s), ${answers} survey answer(s) (${skipped} skipped), ` +
      `${appRoles} app role(s), ` +
      `${echoesFiled} echo(es) filed, ` +
      `${ignoredEchoCount(echoesIgnored)} echo(es) ignored, ` +
      `${parsed.emptyCards} empty card(s) ignored` +
      (failures.length ? `, ${failures.length} failed` : ''),
  );

  // Written on the row by `processWebhook` as it rethrows, and gone from it
  // once an attempt succeeds. Cut short, as the partial-failure note this
  // replaces was: a database outage fails every item of a large batch, each
  // error carries its statement's parameters — customer text — and a dead
  // job's `last_error` is kept for good.
  if (failures.length > 0) {
    const message =
      `${failures.length} item(s) in the batch failed, so the delivery is retried: ` +
      failures.join(' | ');
    throw new Error(message.slice(0, 2000));
  }
}

/**
 * `3 (own 2, standby 1)` — the total first, where the line has always carried
 * it, and the reasons beside it once there are any.
 */
function ignoredEchoCount(ignored: Record<string, number>): string {
  const reasons = Object.entries(ignored).filter(([, count]) => count > 0);
  const total = reasons.reduce((sum, [, count]) => sum + count, 0);
  if (reasons.length === 0) return '0';
  return `${total} (${reasons.map(([reason, count]) => `${reason} ${count}`).join(', ')})`;
}

/** The stored connection, or null for anything that is not one we know. */
function readConnection(value: string | null): MetaConnection | null {
  return isMetaConnection(value) ? value : null;
}
