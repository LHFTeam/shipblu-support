import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client';
import {
  apiTickets,
  contactIdentities,
  contacts,
  conversations,
  csatSurveys,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { env } from '@/lib/env';
import { isTimeout } from '@/lib/http/deadline';
import { logger } from '@/lib/log';
import { messageFrom } from './from';
import { webhookUrl } from './notify';
import { MIN_SECRET_CHARS, usableSecret } from './secrets';
import type { MessageCreatedEvent, SurveyCreatedEvent } from './schemas';
import { contactRefused, externalUserIdOf } from './sessions';

/**
 * The webhook to myBlu's backend (`plans/myblu-ticket-api.md`, _The webhook_;
 * `docs/myblu-api.md`, _The webhook_): what the `notify_myblu` job sends, to
 * where, signed how, and when it sends nothing. Queueing it is
 * `lib/api/notify.ts`.
 *
 * **Ids only.** The body is rebuilt from the rows when each attempt is made,
 * never carried in the job, so a message purged before a retry lands is never
 * sent late, and no text of anybody's ever leaves in it. `user.externalId` is
 * read off the ticket's ownership row, never off the contact, which after a
 * merge has two, and the phone is never sent, so it stays out of a third
 * system's request log.
 *
 * **A failed push never marks a reply failed.** On the app's channel the stored
 * row is the delivery: the reply is in the app on its next poll whether or not
 * the backend was told. So nothing here writes to the message, and a delivery
 * that never succeeds leaves a `dead` job and nothing else.
 */

const log = logger('notify_myblu');

/**
 * How long each attempt waits for the receiver's answer. The receiver answers
 * once it has verified and recorded the event and pushes after, which the guide
 * asks of it, so ten seconds is generous; an attempt not answered by then is
 * retried as a refusal is, and a receiver that pushed before answering gets the
 * same event again and dedupes it.
 */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * No attempt is made for an event older than this, and the job completes with
 * nothing sent. The receiver dedupes on an event's `id` for a day, so every
 * attempt has to fall within a day of the event, or a retry could meet an `id`
 * the receiver has forgotten and push twice. `NOTIFY_MAX_ATTEMPTS` keeps the
 * retries inside that day; this keeps a queue that is itself late — a worker
 * down for a day — inside it too, with an hour to spare for the two clocks to
 * disagree. A push that late is about a reply the app's poll has long since
 * shown; the message is never lost, only the push.
 */
export const MAX_EVENT_AGE_MS = 23 * 60 * 60 * 1000;

type Target = { url: string; secrets: string[] };

export type TargetResolution =
  /** `MYBLU_WEBHOOK_URL` unset: the webhook is switched off, and nothing is sent. */
  | { kind: 'off' }
  /** Set, and not something the worker may post to or sign. `reason` names the variable and the rule, never the value. */
  | { kind: 'refused'; reason: string }
  | { kind: 'ready'; target: Target };

/**
 * Why a URL may not be posted to, or null when it may. Refused here, at first
 * use with nothing sent, and never in `lib/env.ts`, where a format rule turns
 * one mistyped value into a console that does not load.
 *
 * - **`https`.** The body names a user and a ticket, and the signature proves
 *   who sent it, not that nobody read it on the way.
 * - **No userinfo and no query string.** A delivery is authenticated by its
 *   signature alone, so nothing that reads as a credential rides in the
 *   address, which every proxy and request log on the way keeps.
 *
 * The reasons never repeat the URL: a value with a password in it is exactly
 * the one that must not reach a log.
 */
function urlRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'MYBLU_WEBHOOK_URL is not a URL';
  }
  if (url.protocol !== 'https:') return 'MYBLU_WEBHOOK_URL is not https';
  if (url.username !== '' || url.password !== '') {
    return 'MYBLU_WEBHOOK_URL carries userinfo (user:password@), which no delivery may';
  }
  // `includes`, not `url.search`: a bare `?` parses to an empty search, and is
  // still a URL somebody wrote a query onto.
  if (raw.includes('?')) return 'MYBLU_WEBHOOK_URL carries a query string, which no delivery may';
  return null;
}

/**
 * Where the webhook goes and what signs it, read from the environment when a
 * job runs. The URL is posted to exactly as it is set: the receiver registers
 * it as it serves it, and a redirect is not followed (`deliverWebhook`).
 *
 * Read again on every job rather than once at start, so unsetting the URL stops
 * the jobs already queued as soon as the worker restarts with it.
 */
export function webhookTarget(): TargetResolution {
  const url = webhookUrl();
  if (!url) return { kind: 'off' };
  const e = env();

  const refusal = urlRefusal(url);
  if (refusal) return { kind: 'refused', reason: refusal };

  // Trimmed, and a short one reported by name, as the API's own token is
  // (`usableSecret`): the secret keys the HMAC byte for byte.
  const current = usableSecret('MYBLU_WEBHOOK_SECRET', e.MYBLU_WEBHOOK_SECRET);
  if (!current) {
    return {
      kind: 'refused',
      reason: `MYBLU_WEBHOOK_SECRET is unset or shorter than ${MIN_SECRET_CHARS} characters, so nothing would sign the delivery`,
    };
  }
  // The previous secret only ever signs beside the current one, as
  // `MYBLU_API_TOKEN_PREVIOUS` is only ever accepted beside its own.
  // A previous secret cut short is dropped with a warning naming it, so a
  // rotation the receiver has not followed yet fails with a cause in the log.
  const previous = usableSecret('MYBLU_WEBHOOK_SECRET_PREVIOUS', e.MYBLU_WEBHOOK_SECRET_PREVIOUS);
  return { kind: 'ready', target: { url, secrets: previous ? [current, previous] : [current] } };
}

/**
 * `X-ShipBlu-Signature`: `v1=` and the lowercase hex HMAC-SHA256, under each
 * secret, of the timestamp, a `.` and the body exactly as it is sent. The
 * current secret's first; while a rotation is under way the previous one's
 * follows after a comma, and the receiver accepts either.
 *
 * The timestamp is inside the signed text — the half Meta's scheme lacks — so
 * a delivery cannot be replayed later under a fresh one, and it is the
 * attempt's, so a retry is not refused by the receiver's five-minute rule.
 * `webhook.test.ts` recomputes the guide's test vector with this function.
 */
export function signatureHeader(
  secrets: readonly string[],
  timestamp: string,
  body: string,
): string {
  return secrets
    .map(
      (secret) => `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
    )
    .join(',');
}

/**
 * What every event reads about the ticket it is about, in the statement that
 * reads its subject: the ticket, its status, and its owner — the ownership
 * row's identity and the contact it hangs off now, null when the ticket has no
 * ownership row.
 */
export type TicketPart = {
  ticketId: string;
  number: number;
  channel: string;
  status: z.input<typeof MessageCreatedEvent>['ticket']['status'];
  withdrawn: boolean;
  requesterContactId: string | null;
  owner: {
    identifier: string;
    contactId: string;
    isBlocked: boolean;
    deletedAt: Date | null;
  } | null;
};

/**
 * The ticket's columns for a subject's statement, which joins the ticket, its
 * status and — left, so a ticket with no ownership row reads as one with no
 * owner rather than as a missing subject — its owner.
 */
const ticketColumns = {
  ticketId: conversations.id,
  number: conversations.number,
  channel: conversations.channel,
  status: ticketStatuses.category,
  deletedAt: conversations.deletedAt,
  isSpam: conversations.isSpam,
  mergedIntoId: conversations.mergedIntoId,
  requesterContactId: conversations.requesterContactId,
  identifier: contactIdentities.identifier,
  ownerContactId: contactIdentities.contactId,
  ownerIsBlocked: contacts.isBlocked,
  ownerDeletedAt: contacts.deletedAt,
};

/** `ticketColumns` as a row reads them: the owner's half null when no ownership row joined. */
type TicketColumns = {
  ticketId: string;
  number: number;
  channel: string;
  status: TicketPart['status'];
  deletedAt: Date | null;
  isSpam: boolean;
  mergedIntoId: string | null;
  requesterContactId: string | null;
  identifier: string | null;
  ownerContactId: string | null;
  ownerIsBlocked: boolean | null;
  ownerDeletedAt: Date | null;
};

function ticketPart(row: TicketColumns): TicketPart {
  return {
    ticketId: row.ticketId,
    number: row.number,
    channel: row.channel,
    status: row.status,
    withdrawn: row.deletedAt !== null || row.isSpam || row.mergedIntoId !== null,
    requesterContactId: row.requesterContactId,
    owner:
      row.identifier !== null && row.ownerContactId !== null && row.ownerIsBlocked !== null
        ? {
            identifier: row.identifier,
            contactId: row.ownerContactId,
            isBlocked: row.ownerIsBlocked,
            deletedAt: row.ownerDeletedAt,
          }
        : null,
  };
}

/** What the job reads about the message it was queued for, in one statement. */
export type MessageSubject = TicketPart & {
  messageId: string;
  direction: 'inbound' | 'outbound';
  kind: string;
  byAgent: boolean;
  createdAt: Date;
};

/**
 * The message, its ticket and the ticket's owner, or null when the message is
 * gone. A ticket with no ownership row — an account deleted since, whose rows
 * the revoke removed — reads as one with no owner rather than as a missing
 * message, and the job says which it met.
 *
 * A read, not a lock: the event says something happened, and the receiver
 * reads what the ticket is like now through the client plane.
 */
export async function readMessageSubject(messageId: string): Promise<MessageSubject | null> {
  const [row] = await db
    .select({
      messageId: messages.id,
      direction: messages.direction,
      kind: messages.kind,
      authorAgentId: messages.authorAgentId,
      createdAt: messages.createdAt,
      ...ticketColumns,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(apiTickets, eq(apiTickets.conversationId, conversations.id))
    .leftJoin(contactIdentities, eq(contactIdentities.id, apiTickets.identityId))
    .leftJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) return null;

  return {
    ...ticketPart(row),
    messageId: row.messageId,
    direction: row.direction,
    kind: row.kind,
    byAgent: row.authorAgentId !== null,
    createdAt: row.createdAt,
  };
}

/** What the job reads about the survey it was queued for, in one statement. */
export type SurveySubject = TicketPart & {
  surveyId: string;
  surveyStatus: 'sent' | 'answered' | 'skipped' | 'expired';
  delivery: string | null;
  /** When it was sent: the instant the event reports, and its day counts from. */
  sentAt: Date | null;
};

/** The survey, its ticket and the ticket's owner, or null when the survey is gone; read as `readMessageSubject` reads. */
export async function readSurveySubject(surveyId: string): Promise<SurveySubject | null> {
  const [row] = await db
    .select({
      surveyId: csatSurveys.id,
      surveyStatus: csatSurveys.status,
      delivery: csatSurveys.delivery,
      sentAt: csatSurveys.sentAt,
      ...ticketColumns,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .leftJoin(apiTickets, eq(apiTickets.conversationId, conversations.id))
    .leftJoin(contactIdentities, eq(contactIdentities.id, apiTickets.identityId))
    .leftJoin(contacts, eq(contacts.id, contactIdentities.contactId))
    .where(eq(csatSurveys.id, surveyId))
    .limit(1);
  if (!row) return null;

  return {
    ...ticketPart(row),
    surveyId: row.surveyId,
    surveyStatus: row.surveyStatus,
    delivery: row.delivery,
    sentAt: row.sentAt,
  };
}

/** Why a job sends nothing and completes: each a state the ticket can honestly be in. */
export type QuietReason =
  /** Deleted, marked spam or merged away since the reply: out of the app, as `ownedTicket` takes it out. */
  | 'withdrawn'
  /**
   * No ownership row, or one whose user can no longer read the ticket: an
   * account deleted or a number released (the revoke removes the rows), or a
   * requester that is no longer the owner's contact, which `ownedTicket`
   * refuses the app too.
   */
  | 'not_in_app'
  /** The owner's contact is blocked or deleted: every request of theirs is refused, so a push is one they cannot open. */
  | 'refused'
  /** Older than `MAX_EVENT_AGE_MS`. */
  | 'stale'
  /**
   * A survey no longer waiting for an answer: answered since — in the app, or
   * through a link — or superseded by a newer one. A push asking the user to
   * rate it would open a survey with nothing to tap.
   */
  | 'not_waiting'
  /**
   * The ticket is open or pending again: a survey asks how a resolved ticket
   * went, and a push asking to rate one the user has since written on — a
   * reply right after the resolve, or a receiver failing until the job's
   * retries ran late — prompts about a conversation still going.
   */
  | 'reopened';

export type Decision<E> =
  | { kind: 'send'; event: E }
  | { kind: 'quiet'; reason: QuietReason }
  /**
   * Not now. The API is switched off (`apiSwitchedOn`), so every request the
   * app makes answers `503 not_configured` and a push would point at nothing
   * it can open — but the reply or the survey is still there for when it comes
   * back on. So the attempt fails, a plain error the queue retries, as an
   * unusable target does, rather than completing: a token unset or pasted
   * short for ten minutes during a rotation then costs a few retries, not
   * every push in those ten minutes. The day's bound holds because `stale` is
   * asked first, on every attempt.
   */
  | { kind: 'later'; reason: 'api_off' }
  /**
   * Not a subject the webhook is ever about: for `message.created` an inbound
   * message, a note, or one on another channel; for `survey.created` a survey
   * the app does not pull. Only a payload written by hand names one, since the
   * doors queue only the team's replies and the app's surveys on `api`, so it
   * is refused rather than sent — which is what stops a hand-made payload
   * carrying a note's id out.
   */
  | { kind: 'refuse'; reason: string };

/**
 * Whether the app could open what a push about this ticket points at, and
 * whose app it is: the user's `externalId`, read off the ownership row's
 * identity, or why not. The states `ownedTicket` refuses the app, in its
 * order; one function, so the two events cannot push for a ticket one of them
 * would leave alone.
 */
function inApp(
  ticket: TicketPart,
): { kind: 'in_app'; externalId: string } | { kind: 'quiet'; reason: QuietReason } {
  if (ticket.withdrawn) return { kind: 'quiet', reason: 'withdrawn' };
  const owner = ticket.owner;
  const externalId = owner ? externalUserIdOf(owner.identifier) : null;
  if (!owner || externalId === null || owner.contactId !== ticket.requesterContactId) {
    return { kind: 'quiet', reason: 'not_in_app' };
  }
  if (contactRefused(owner)) return { kind: 'quiet', reason: 'refused' };
  return { kind: 'in_app', externalId };
}

function stale(at: Date, now: Date): boolean {
  return now.getTime() - at.getTime() > MAX_EVENT_AGE_MS;
}

/**
 * Whether to send `message.created` for this message now, and the body if so.
 * Pure, so every branch is a test rather than a database fixture: whether the
 * API is on is asked by the caller (`apiSwitchedOn`) and handed in, required,
 * so no caller can decide without it.
 *
 * The refusal is checked first, so a payload naming a note is refused whatever
 * the ticket is like; then the states in which the app could not open what
 * the push points at, in the order `ownedTicket` would refuse it; then the
 * age; and only then the API itself, the one answer that is not final, so a
 * retry made while it is off still completes once the event is past its day
 * or the ticket has left the app.
 */
export function decideMessageCreated(
  subject: MessageSubject,
  now: Date,
  apiOn: boolean,
): Decision<z.input<typeof MessageCreatedEvent>> {
  if (subject.direction !== 'outbound' || subject.kind !== 'reply') {
    return { kind: 'refuse', reason: 'not a reply from the team' };
  }
  if (subject.channel !== 'api') {
    return { kind: 'refuse', reason: `a reply on ${subject.channel}, not on the myBlu app` };
  }
  const standing = inApp(subject);
  if (standing.kind === 'quiet') return standing;
  if (stale(subject.createdAt, now)) return { kind: 'quiet', reason: 'stale' };
  if (!apiOn) return { kind: 'later', reason: 'api_off' };

  return {
    kind: 'send',
    event: messageCreatedEvent({
      messageId: subject.messageId,
      from: messageFrom(subject),
      occurredAt: subject.createdAt,
      externalId: standing.externalId,
      ticket: { id: subject.ticketId, number: subject.number, status: subject.status },
    }),
  };
}

/**
 * Whether to send `survey.created` for this survey now, and the body if so:
 * `decideMessageCreated`'s order, for a survey the app pulls (`api_pull`),
 * still waiting for an answer, on a ticket still resolved or closed — nothing
 * expires a survey when its ticket reopens, only a newer send does, so the
 * ticket's status is asked here. Its day counts from when it was sent.
 */
export function decideSurveyCreated(
  subject: SurveySubject,
  now: Date,
  apiOn: boolean,
): Decision<z.input<typeof SurveyCreatedEvent>> {
  if (subject.delivery !== 'api_pull' || subject.channel !== 'api' || subject.sentAt === null) {
    return { kind: 'refuse', reason: 'not a survey the myBlu app pulls' };
  }
  const standing = inApp(subject);
  if (standing.kind === 'quiet') return standing;
  if (subject.surveyStatus !== 'sent') return { kind: 'quiet', reason: 'not_waiting' };
  if (subject.status !== 'resolved' && subject.status !== 'closed') {
    return { kind: 'quiet', reason: 'reopened' };
  }
  if (stale(subject.sentAt, now)) return { kind: 'quiet', reason: 'stale' };
  if (!apiOn) return { kind: 'later', reason: 'api_off' };

  return {
    kind: 'send',
    event: surveyCreatedEvent({
      surveyId: subject.surveyId,
      occurredAt: subject.sentAt,
      externalId: standing.externalId,
      ticket: { id: subject.ticketId, number: subject.number, status: subject.status },
    }),
  };
}

/**
 * The body, in the order the guide prints it, so its bytes are the guide's
 * test vector's for the vector's values (`webhook.test.ts`). Typed by the
 * published schema's input, so a field the contract renames does not compile
 * here, and built field by field, so nothing rides along.
 */
export function messageCreatedEvent(values: {
  messageId: string;
  from: z.input<typeof MessageCreatedEvent>['message']['from'];
  occurredAt: Date;
  externalId: string;
  ticket: z.input<typeof MessageCreatedEvent>['ticket'];
}): z.input<typeof MessageCreatedEvent> {
  const id = `message.created:${values.messageId}`;
  return {
    version: 1,
    id,
    type: 'message.created',
    occurredAt: values.occurredAt.toISOString(),
    user: { externalId: values.externalId },
    ticket: { id: values.ticket.id, number: values.ticket.number, status: values.ticket.status },
    message: { id: values.messageId, from: values.from },
  };
}

/**
 * `survey.created`'s body, in `message.created`'s order with `survey` in
 * `message`'s place. `expiresAt` is null: nothing lapses a survey but a newer
 * one, which the app then reads as `expired`.
 */
export function surveyCreatedEvent(values: {
  surveyId: string;
  occurredAt: Date;
  externalId: string;
  ticket: z.input<typeof SurveyCreatedEvent>['ticket'];
}): z.input<typeof SurveyCreatedEvent> {
  return {
    version: 1,
    id: `survey.created:${values.surveyId}`,
    type: 'survey.created',
    occurredAt: values.occurredAt.toISOString(),
    user: { externalId: values.externalId },
    ticket: { id: values.ticket.id, number: values.ticket.number, status: values.ticket.status },
    survey: { id: values.surveyId, expiresAt: null },
  };
}

/** A delivery the receiver did not take: a plain error, which the queue retries. */
class WebhookNotTaken extends Error {
  override readonly name = 'WebhookNotTaken';
}

/**
 * One attempt: the event, signed now, posted to the target. Answers the
 * receiver's status when it took the delivery (`2xx`), and throws otherwise —
 * a refusal, a redirect, no answer in time, no connection — so the queue
 * retries the job, never `PermanentJobError`: a receiver that is down or
 * mid-deploy is exactly what the retries are for.
 *
 * **A redirect is not followed** (`redirect: 'error'`): following one would
 * send the signed body wherever the redirect points. So a `3xx` is a failed
 * attempt, and a receiver registers its URL as it serves it.
 *
 * Nothing of the answer is read but its status, and its body is discarded
 * unread, so a receiver's error page never reaches a log or `jobs.last_error`.
 * Nor does the body sent, which names a user.
 */
export async function deliverWebhook(
  target: Target,
  event: { id: string; type: string },
  now: Date,
): Promise<number> {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(now.getTime() / 1000));

  let response: Response;
  try {
    response = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-ShipBlu-Event': event.type,
        'X-ShipBlu-Event-Id': event.id,
        'X-ShipBlu-Timestamp': timestamp,
        'X-ShipBlu-Signature': signatureHeader(target.secrets, timestamp, body),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeout(error)) {
      throw new WebhookNotTaken(
        `the receiver did not answer within ${WEBHOOK_TIMEOUT_MS / 1000} s`,
      );
    }
    // A redirect lands here too: `redirect: 'error'` rejects the fetch.
    throw new WebhookNotTaken(
      'no answer from the receiver: a redirect, or the connection, TLS or DNS failed',
      { cause: error },
    );
  }

  // Released unread: an unread body holds its connection until it is
  // collected. A failure to cancel says nothing about the delivery.
  await response.body?.cancel().catch(() => undefined);

  if (!response.ok) {
    throw new WebhookNotTaken(`the receiver answered ${response.status}`);
  }
  log.info('delivered', { eventId: event.id, status: response.status });
  return response.status;
}
