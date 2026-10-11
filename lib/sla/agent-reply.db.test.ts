import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

/**
 * A reopen committing in the middle of `onAgentReply`.
 *
 * A reply typed on the WhatsApp Business app is processed as a job, beside the
 * job for the customer's next message, and nothing serialises the two. When the
 * late reply finds a customer message no clock was started for, it starts one —
 * and the customer's job can reopen the ticket between that decision's first
 * read and its write. The interleaving is forced here by running the customer's
 * transaction just before the first `select` the database sees after `armed`
 * is set: in `onAgentReply` that is the first read after its UPDATE.
 */
const gap = vi.hoisted(() => ({
  armed: false,
  fired: false,
  run: null as null | (() => Promise<void>),
}));

vi.mock('@/db/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/client')>();
  const db = new Proxy(actual.db, {
    get(target, property, receiver) {
      if (property !== 'select' || !gap.armed) return Reflect.get(target, property, receiver);
      gap.armed = false;
      return (...args: Parameters<typeof target.select>) => {
        const builder = target.select(...args);
        const from = builder.from.bind(builder);
        return Object.assign(builder, {
          from: (...source: Parameters<typeof from>) => {
            const query = from(...source);
            const then = query.then.bind(query);
            return Object.assign(query, {
              then: (...handlers: Parameters<typeof then>) => {
                gap.fired = true;
                return gap.run!().then(() => then(...handlers));
              },
            });
          },
        });
      };
    },
  });
  return { ...actual, db };
});

import { db } from '@/db/client';
import {
  contacts,
  conversationEvents,
  conversations,
  slaPolicies,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { cairo } from '@/lib/testing/time';
import { latest } from '@/lib/tickets/latest';
import { reopenResolved } from '@/lib/tickets/reopen';
import {
  applySlaOnCreate,
  onAgentReply,
  onCustomerReply,
  onPriorityChanged,
  onStatusChanged,
} from './index';

withCleanDatabase();

/**
 * Against the seeded Cairo calendar, Sunday to Thursday 09:00–17:00; Thursday
 * 8 October 2026 is a working day. The same targets for every priority, so the
 * re-time at the end moves nothing but what the pauses credit.
 */
const TARGET = { firstResponseMins: 60, nextResponseMins: 60, resolutionMins: 240 };
const TARGETS = { low: TARGET, medium: TARGET, high: TARGET, urgent: TARGET };

const OPENED = cairo('2026-10-08T10:00');
/** The phone reply, typed before the customer's second message. */
const PHONE_REPLY = cairo('2026-10-08T10:10');
const SECOND = cairo('2026-10-08T10:20');
const RESOLVED = cairo('2026-10-08T10:30');
const REOPENING = cairo('2026-10-08T12:00');

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

/**
 * Opened at 10:00, written to again at 10:20 before anybody answered — so no
 * next-response clock — and resolved at 10:30, which pauses the clocks.
 */
async function resolvedTicket(): Promise<string> {
  await db.insert(slaPolicies).values({ name: 'Office hours', targets: TARGETS, isDefault: true });
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      requesterContactId: contact!.id,
      statusId: await statusId('Open'),
      channel: 'whatsapp',
      createdAt: OPENED,
      lastCustomerMessageAt: OPENED,
    })
    .returning({ id: conversations.id });
  const id = row!.id;
  await applySlaOnCreate(id);

  await db
    .update(conversations)
    .set({ lastCustomerMessageAt: SECOND, lastMessageAt: SECOND })
    .where(eq(conversations.id, id));
  await onCustomerReply(id, SECOND);

  await db
    .update(conversations)
    .set({ statusId: await statusId('Resolved'), resolvedAt: RESOLVED })
    .where(eq(conversations.id, id));
  await onStatusChanged(id, true, RESOLVED);
  return id;
}

/** The customer's job: its ingest transaction, reopening the ticket. */
async function reopenedByCustomer(id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [ticket] = await tx
      .select({ reopenCount: conversations.reopenCount })
      .from(conversations)
      .where(eq(conversations.id, id));
    await reopenResolved(
      tx as unknown as typeof db,
      { id, reopenCount: ticket!.reopenCount },
      { actorLabel: 'inbound_whatsapp', reason: 'customer_replied' },
    );
    await tx
      .update(conversations)
      .set({
        lastMessageAt: latest(conversations.lastMessageAt, REOPENING),
        lastCustomerMessageAt: latest(conversations.lastCustomerMessageAt, REOPENING),
      })
      .where(eq(conversations.id, id));
  });
}

/** The phone reply's job, up to and including its `onAgentReply`. */
async function phoneReply(id: string): Promise<void> {
  await db
    .update(conversations)
    .set({
      lastMessageAt: latest(conversations.lastMessageAt, PHONE_REPLY),
      lastAgentMessageAt: latest(conversations.lastAgentMessageAt, PHONE_REPLY),
    })
    .where(eq(conversations.id, id));
  await onAgentReply(id, PHONE_REPLY);
}

async function resumes(id: string) {
  return db
    .select({ data: conversationEvents.data })
    .from(conversationEvents)
    .where(
      and(eq(conversationEvents.conversationId, id), eq(conversationEvents.type, 'sla_resumed')),
    )
    .orderBy(asc(conversationEvents.createdAt));
}

/** The resolution target after a re-time, which rebuilds it from the pauses recorded. */
async function retimedResolutionDue(id: string): Promise<Date | null> {
  await db.update(conversations).set({ priority: 'high' }).where(eq(conversations.id, id));
  await onPriorityChanged(id);
  const [row] = await db
    .select({ resolutionDueAt: conversations.resolutionDueAt })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.resolutionDueAt;
}

describe('onAgentReply beside a reopen', () => {
  // 10:00 + 240 working minutes, plus the 90 the ticket sat resolved.
  const DUE = cairo('2026-10-08T15:30');

  it('credits the resolved time when the phone reply is processed first', async () => {
    const id = await resolvedTicket();

    await phoneReply(id);
    await reopenedByCustomer(id);
    await onCustomerReply(id, REOPENING);

    expect(await resumes(id)).toEqual([{ data: expect.objectContaining({ pausedMinutes: 90 }) }]);
    expect(await retimedResolutionDue(id)).toEqual(DUE);
  });

  it('credits the same when the reopen commits while the phone reply is deciding', async () => {
    const id = await resolvedTicket();

    gap.run = () => reopenedByCustomer(id);
    gap.fired = false;
    gap.armed = true;
    await phoneReply(id);
    expect(gap.fired).toBe(true);
    // The team's reply never ends a pause: the reopen is the customer's.
    expect(await resumes(id)).toEqual([]);

    await onCustomerReply(id, REOPENING);

    // One resume, crediting the whole 90 minutes. Ending the pause from the
    // instant `onAgentReply` read before the reopen committed wrote a resume
    // of 0 minutes at the pause's own start, which the re-time then paired with
    // the pause in place of this one, and the ticket lost its resolved time.
    expect(await resumes(id)).toEqual([{ data: expect.objectContaining({ pausedMinutes: 90 }) }]);
    expect(await retimedResolutionDue(id)).toEqual(DUE);
  });
});
