import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  contactIdentities,
  contacts,
  conversations,
  csatSurveys,
  jobs,
  messages,
  ticketStatuses,
  webhookEvents,
} from '@/db/schema';
import { sendSurvey } from '@/lib/csat';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { processWebhook } from './process-webhook';

/**
 * A Facebook or Instagram batch with one item that fails, from the stored row
 * through the real parser and dispatcher: the job fails so the queue runs the
 * delivery again, the retry records what failed, and what had worked the first
 * time is not written twice.
 *
 * It used to fail only when every item had, so the case from review on #377 —
 * a survey answer whose write hit a dropped connection, in a batch whose other
 * message went in — marked the delivery processed and lost the rating.
 */

/**
 * Each mock passes through to the real module, and fails once for an item a
 * test names, as a dropped database connection would: a survey answer, a
 * direct message by its mid, or the download queued for an attachment's URL.
 */
const failing = vi.hoisted(() => ({
  surveys: new Set<string>(),
  mids: new Set<string>(),
  downloads: new Set<string>(),
}));

vi.mock('@/lib/csat/meta-feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/csat/meta-feedback')>();
  return {
    ...actual,
    recordMetaFeedback: vi.fn(async (feedback: Parameters<typeof actual.recordMetaFeedback>[0]) => {
      if (failing.surveys.delete(feedback.surveyId)) {
        throw new Error('Connection terminated unexpectedly');
      }
      return actual.recordMetaFeedback(feedback);
    }),
  };
});

vi.mock('@/lib/tickets/ingest-meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tickets/ingest-meta')>();
  return {
    ...actual,
    ingestMetaMessage: vi.fn(async (message: Parameters<typeof actual.ingestMetaMessage>[0]) => {
      if (failing.mids.delete(message.mid)) throw new Error('Connection terminated unexpectedly');
      return actual.ingestMetaMessage(message);
    }),
  };
});

vi.mock('@/lib/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queue')>();
  return {
    ...actual,
    enqueue: vi.fn(async (...args: Parameters<typeof actual.enqueue>) => {
      const [type, payload] = args;
      const url = (payload as { url?: unknown }).url;
      if (type === 'download_media' && typeof url === 'string' && failing.downloads.delete(url)) {
        throw new Error('Connection terminated unexpectedly');
      }
      return actual.enqueue(...args);
    }),
  };
});

// The account a reply is addressed from, so the tap's thanks has somewhere to go.
vi.mock('@/lib/meta/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meta/client')>()),
  configuredAccountId: () => ACCOUNT,
}));

withCleanDatabase();

beforeEach(() => {
  failing.surveys.clear();
  failing.mids.clear();
  failing.downloads.clear();
});

const ACCOUNT = 'account-1';
const MINUTE = 60_000;

type MessagingEvent = Record<string, unknown>;

function dm(from: string, mid: string, at: number, message: Record<string, unknown> = {}) {
  return {
    sender: { id: from },
    recipient: { id: ACCOUNT },
    timestamp: at,
    message: { mid, text: 'Where is my parcel?', ...message },
  };
}

function tap(from: string, surveyId: string, rating: number, at: number) {
  return dm(from, `m_tap_${surveyId}`, at, {
    text: 'Great',
    quick_reply: { payload: `csat:${surveyId}:${rating}` },
  });
}

/** An Instagram batch, stored the way the webhook route stores it. */
async function store(messaging: MessagingEvent[]): Promise<string> {
  const [event] = await db
    .insert(webhookEvents)
    .values({
      provider: 'meta',
      channel: 'instagram',
      connection: 'instagram_login',
      payload: { object: 'instagram', entry: [{ id: ACCOUNT, time: Date.now(), messaging }] },
      signatureVerified: true,
    })
    .returning({ id: webhookEvents.id });
  return event!.id;
}

/** One run of the job for a stored delivery, as the queue makes on each attempt. */
function run(webhookEventId: string): Promise<void> {
  return processWebhook({
    id: 'job-1',
    type: 'process_webhook',
    payload: { webhookEventId },
  } as unknown as ClaimedJob);
}

async function delivery(id: string) {
  const [row] = await db
    .select({
      processedAt: webhookEvents.processedAt,
      attempts: webhookEvents.attempts,
      error: webhookEvents.error,
    })
    .from(webhookEvents)
    .where(eq(webhookEvents.id, id));
  return row!;
}

/** Every stored message, by its mid, oldest first. */
async function storedMids() {
  const rows = await db
    .select({ mid: messages.channelMessageId, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.direction, 'inbound'));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((r) => r.mid);
}

/** A resolved Instagram ticket for `psid`, surveyed with quick replies. */
async function surveyedTicket(psid: string) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  await db
    .insert(contactIdentities)
    .values({ contactId: contact!.id, channel: 'instagram', identifier: psid });
  const [resolved] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Resolved'));
  const [ticket] = await db
    .insert(conversations)
    .values({
      channel: 'instagram',
      statusId: resolved!.id,
      requesterContactId: contact!.id,
      lastCustomerMessageAt: new Date(Date.now() - 60 * MINUTE),
    })
    .returning({ id: conversations.id });

  const sent = await sendSurvey({
    conversationId: ticket!.id,
    locale: 'en',
    delivery: 'meta_quick_reply',
    snapshot: { agentId: null, groupId: null, channel: 'instagram' },
    resurveyAfterDays: 14,
    ruleId: null,
    requesterEmail: null,
    body: () => ({ text: 'Your ticket is resolved.\nHow did we do?', html: null }),
  });
  if (sent.kind !== 'sent') throw new Error(`no survey: ${sent.kind}`);
  return { conversationId: ticket!.id, ...sent };
}

describe('processWebhook — a Meta batch with an item that failed', () => {
  it('retries a survey answer that failed beside a message that went in', async () => {
    const amira = await surveyedTicket('igsid-amira');
    const now = Date.now();
    const id = await store([
      dm('igsid-karim', 'm_karim', now - 2 * MINUTE),
      tap('igsid-amira', amira.surveyId, 5, now - MINUTE),
    ]);
    failing.surveys.add(amira.surveyId);

    await expect(run(id)).rejects.toThrow(`survey answer for ${amira.surveyId}`);
    expect(await delivery(id)).toMatchObject({ processedAt: null, attempts: 1 });
    expect((await delivery(id)).error).toContain(`survey answer for ${amira.surveyId}`);
    expect(await storedMids()).toEqual(['m_karim']);

    await run(id);

    // Recovered, so nothing on the row says an item was lost.
    expect(await delivery(id)).toMatchObject({ processedAt: expect.any(Date), attempts: 2 });
    expect((await delivery(id)).error).toBeNull();
    const [survey] = await db
      .select({ status: csatSurveys.status, rating: csatSurveys.rating })
      .from(csatSurveys)
      .where(eq(csatSurveys.id, amira.surveyId));
    expect(survey).toEqual({ status: 'answered', rating: 5 });
    // The message that went in the first time is not stored again.
    expect(await storedMids()).toEqual(['m_karim']);
    // Thanked once, on the attempt that recorded the answer.
    const outbound = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.conversationId, amira.conversationId), eq(messages.direction, 'outbound')),
      );
    expect(outbound.filter((row) => row.id !== amira.messageId)).toHaveLength(1);
  });

  it('stores a message that failed after a newer one, and leaves the ticket on the newer', async () => {
    const now = Date.now();
    const older = now - 5 * MINUTE;
    const newer = now - MINUTE;
    const id = await store([
      dm('igsid-karim', 'm_older', older, { text: 'Where is my parcel?' }),
      dm('igsid-karim', 'm_newer', newer, { text: 'Hello?' }),
    ]);
    failing.mids.add('m_older');

    await expect(run(id)).rejects.toThrow('m_older');
    expect(await storedMids()).toEqual(['m_newer']);

    await run(id);

    expect(await storedMids()).toEqual(['m_older', 'm_newer']);
    const [ticket] = await db
      .select({
        lastMessageAt: conversations.lastMessageAt,
        lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      })
      .from(conversations);
    expect(ticket).toEqual({
      lastMessageAt: new Date(newer),
      lastCustomerMessageAt: new Date(newer),
    });
  });

  it('queues a download with its message or not at all, so the retry gets both', async () => {
    const first = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1';
    const second = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=2';
    const id = await store([
      dm('igsid-karim', 'm_photo', Date.now() - MINUTE, {
        text: undefined,
        attachments: [
          { type: 'image', payload: { url: first } },
          { type: 'image', payload: { url: second } },
        ],
      }),
    ]);
    // The second, so the first is already queued when the transaction fails.
    failing.downloads.add(second);

    // Queued after the message committed, the failed download left a stored
    // message that every retry finds by its mid and stops at. Queued on the
    // pool rather than the transaction, the first download would outlive the
    // message it names.
    await expect(run(id)).rejects.toThrow('m_photo');
    expect(await storedMids()).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.type, 'download_media'))).toEqual([]);

    await run(id);

    const [message] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.channelMessageId, 'm_photo'));
    const downloads = await db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.type, 'download_media'));
    expect(downloads).toEqual([
      { payload: { messageId: message!.id, url: first, index: 0, source: 'meta' } },
      { payload: { messageId: message!.id, url: second, index: 1, source: 'meta' } },
    ]);
  });
});
