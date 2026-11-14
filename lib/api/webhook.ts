import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client';
import {
  apiTickets,
  contactIdentities,
  contacts,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { env } from '@/lib/env';
import { isTimeout } from '@/lib/http/deadline';
import { logger } from '@/lib/log';
import { messageFrom } from './from';
import type { MessageCreatedEvent } from './schemas';
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

/**
 * Below this a secret counts as unset, the rule `MYBLU_API_TOKEN` follows
 * (`lib/api/auth.ts`): a signing secret short enough to have been typed by
 * hand, or cut off when pasted, signs nothing rather than signing weakly.
 */
const MIN_SECRET_CHARS = 32;

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

function usableSecret(value: string | undefined): string | null {
  return value && value.length >= MIN_SECRET_CHARS ? value : null;
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
  const e = env();
  const url = e.MYBLU_WEBHOOK_URL?.trim();
  if (!url) return { kind: 'off' };

  const refusal = urlRefusal(url);
  if (refusal) return { kind: 'refused', reason: refusal };

  const current = usableSecret(e.MYBLU_WEBHOOK_SECRET);
  if (!current) {
    return {
      kind: 'refused',
      reason: `MYBLU_WEBHOOK_SECRET is unset or shorter than ${MIN_SECRET_CHARS} characters, so nothing would sign the delivery`,
    };
  }
  // The previous secret only ever signs beside the current one, as
  // `MYBLU_API_TOKEN_PREVIOUS` is only ever accepted beside its own.
  const previous = usableSecret(e.MYBLU_WEBHOOK_SECRET_PREVIOUS);
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

/** What the job reads about the message it was queued for, in one statement. */
export type MessageSubject = {
  messageId: string;
  direction: 'inbound' | 'outbound';
  kind: string;
  byAgent: boolean;
  createdAt: Date;
  ticketId: string;
  number: number;
  channel: string;
  status: z.input<typeof MessageCreatedEvent>['ticket']['status'];
  withdrawn: boolean;
  requesterContactId: string | null;
  /** The ownership row's identity, and the contact it hangs off now; null when the ticket has no ownership row. */
  owner: {
    identifier: string;
    contactId: string;
    isBlocked: boolean;
    deletedAt: Date | null;
  } | null;
};

/**
 * The message, its ticket and the ticket's owner, or null when the message is
 * gone. Left joins past the ticket, so a ticket with no ownership row — an
 * account deleted since, whose rows the revoke removed — reads as one with no
 * owner rather than as a missing message, and the job says which it met.
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
    messageId: row.messageId,
    direction: row.direction,
    kind: row.kind,
    byAgent: row.authorAgentId !== null,
    createdAt: row.createdAt,
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
  | 'stale';

export type Decision =
  | { kind: 'send'; event: z.input<typeof MessageCreatedEvent> }
  | { kind: 'quiet'; reason: QuietReason }
  /**
   * Not a message the webhook is ever about: an inbound one, a note, or one on
   * another channel. Only a payload written by hand names one, since both
   * doors queue only the team's replies on `api`, so it is refused rather than
   * sent — which is what stops a hand-made payload carrying a note's id out.
   */
  | { kind: 'refuse'; reason: string };

/**
 * Whether to send `message.created` for this message now, and the body if so.
 * Pure, so every branch is a test rather than a database fixture.
 *
 * The refusal is checked first, so a payload naming a note is refused whatever
 * the ticket is like; then the states in which the app could not open what the
 * push points at, in the order `ownedTicket` would refuse it; then the age.
 */
export function decideMessageCreated(subject: MessageSubject, now: Date): Decision {
  if (subject.direction !== 'outbound' || subject.kind !== 'reply') {
    return { kind: 'refuse', reason: 'not a reply from the team' };
  }
  if (subject.channel !== 'api') {
    return { kind: 'refuse', reason: `a reply on ${subject.channel}, not on the myBlu app` };
  }
  if (subject.withdrawn) return { kind: 'quiet', reason: 'withdrawn' };

  const owner = subject.owner;
  const externalId = owner ? externalUserIdOf(owner.identifier) : null;
  if (!owner || externalId === null || owner.contactId !== subject.requesterContactId) {
    return { kind: 'quiet', reason: 'not_in_app' };
  }
  if (contactRefused(owner)) return { kind: 'quiet', reason: 'refused' };
  if (now.getTime() - subject.createdAt.getTime() > MAX_EVENT_AGE_MS) {
    return { kind: 'quiet', reason: 'stale' };
  }

  return {
    kind: 'send',
    event: messageCreatedEvent({
      messageId: subject.messageId,
      from: messageFrom(subject),
      occurredAt: subject.createdAt,
      externalId,
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
