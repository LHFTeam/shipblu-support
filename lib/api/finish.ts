import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { apiTickets, messages } from '@/db/schema';
import { logger, scrubbed } from '@/lib/log';
import { enqueue, takeQueuedJob } from '@/lib/queue';
import { linkClaimedTrackingNumber } from '@/lib/shipments/links';
import { afterInboundMessage, afterMessageStored } from '@/lib/tickets/lifecycle';

const log = logger('api');

/**
 * The work a message from the app is owed once its transaction commits — the
 * claimed tracking number's link, then the ingest lifecycle every channel runs
 * (`afterMessageStored`, `afterInboundMessage`): the on-create or on-update
 * rules, the SLA, routing, assignment and the out-of-hours reply — and who
 * runs it.
 *
 * The request runs it, as every other ingest path does, right after the
 * commit. But a request can end between the commit and that work — a deploy's
 * shutdown, a dropped connection, a failure answered `500` — and the app then
 * sends the same `Idempotency-Key` again, which is answered from what was
 * stored (`replay`): with the work run inline only, the ticket was left for
 * good without its rules, its first policy, its assignee or its reply, and the
 * idempotency that spares the user a second ticket was what made the loss
 * permanent. So the transaction that stores the message also writes a
 * `finish_api_message` job, keyed on the message and due a minute later
 * (`oweFinish`). The request takes that job before it runs the work
 * (`finishInRequest`); a request that never got there leaves it for the
 * worker, which runs the same work from the stored rows (`owedFor`,
 * `finishStored`). Taking it is one conditional update on a row nobody has run
 * (`takeQueuedJob`), so exactly one of the two runs the work.
 *
 * Neither runs it twice. A step that fails part-way is logged, as on every
 * channel, and the rest goes on or stops there; nothing re-runs the steps that
 * succeeded, since a rule's reply sent twice is a larger harm than a step left
 * undone (`settle_routing` weighs a dead claimant's rules the same way).
 */

/** How long the backstop waits for the request to take the work itself. */
const BACKSTOP_AFTER_MS = 60_000;

const finishKey = (messageId: string) => `finish_api_message:${messageId}`;

/** What `finishStored` runs on, from the request or read back off the rows. */
export type Owed = {
  conversationId: string;
  messageId: string;
  bodyText: string;
  /** Whether the message opened the ticket: the creation pass, not a reply's. */
  created: boolean;
  /** The message's `created_at`, which the reply's clock counts from. */
  at: Date;
  /** The number the app claimed on a create, linked before the rules run. */
  trackingNumber: string | null;
};

/**
 * Writes the backstop in the transaction that stores the message, so it
 * commits with the message or not at all, its key with it: a create rolled
 * back on its key's unique index spends nothing.
 */
export async function oweFinish(
  tx: typeof db,
  message: { messageId: string; conversationId: string; now: Date },
): Promise<void> {
  await enqueue(
    'finish_api_message',
    { messageId: message.messageId, conversationId: message.conversationId },
    {
      on: tx,
      runAt: new Date(message.now.getTime() + BACKSTOP_AFTER_MS),
      dedupeKey: finishKey(message.messageId),
      priority: 50,
    },
  );
}

/**
 * After the commit, in the request: take the backstop, then run the work. A
 * take that fails, or finds the job already run, leaves the work to whoever
 * has it. Never throws: the message is stored, and the answer is about it.
 */
export async function finishInRequest(owed: Owed): Promise<void> {
  let taken: boolean;
  try {
    taken = await takeQueuedJob(finishKey(owed.messageId));
  } catch (error) {
    log.error(
      `could not take the work owed a stored message, left to finish_api_message message_id=${owed.messageId}`,
      scrubbed(error),
    );
    return;
  }
  if (taken) await finishStored(owed);
}

/** The work itself, once, whoever took it. Never throws. */
export async function finishStored(owed: Owed): Promise<void> {
  // Before the rules, so a rule reading the ticket's parcels sees the link
  // rather than racing it. Best-effort, as the detector is: a ticket is never
  // left half-processed over the shape of a number.
  if (owed.created && owed.trackingNumber) {
    try {
      await linkClaimedTrackingNumber({
        conversationId: owed.conversationId,
        messageId: owed.messageId,
        trackingNumber: owed.trackingNumber,
      });
    } catch (error) {
      // Scrubbed: the number is a parameter of every query the link runs.
      log.error(
        `could not link a claimed tracking number conversation_id=${owed.conversationId}`,
        scrubbed(error),
      );
    }
  }

  try {
    await afterMessageStored({
      conversationId: owed.conversationId,
      messageId: owed.messageId,
      bodyText: owed.bodyText,
      kind: 'reply',
      direction: 'inbound',
    });
    await afterInboundMessage(owed.conversationId, owed.created, owed.at, {
      id: owed.messageId,
    });
  } catch (error) {
    log.error(
      `the work owed a stored message stopped part-way message_id=${owed.messageId}`,
      scrubbed(error),
    );
  }
}

/**
 * The work a message is owed, read back off what its transaction stored, for
 * the worker: null when the message is gone (purged). The tracking number is
 * the ticket's ownership row's, gone with a release, when nothing is linked.
 */
export async function owedFor(messageId: string): Promise<Owed | null> {
  const [row] = await db
    .select({
      conversationId: messages.conversationId,
      bodyText: messages.bodyText,
      createdAt: messages.createdAt,
      operation: sql<string | null>`${messages.meta}->>'apiOperation'`,
      trackingNumber: sql<
        string | null
      >`(select ${apiTickets.trackingNumber} from ${apiTickets} where ${apiTickets.conversationId} = ${messages.conversationId})`,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) return null;
  return {
    conversationId: row.conversationId,
    messageId,
    bodyText: row.bodyText,
    created: row.operation === 'createTicket',
    at: row.createdAt,
    trackingNumber: row.trackingNumber,
  };
}
