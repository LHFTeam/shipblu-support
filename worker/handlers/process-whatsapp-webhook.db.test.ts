import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { channels, conversations, jobs, messages, webhookEvents } from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import { computeDay, earliestDay, reportingContext } from '@/lib/reports/rollup';
import { withCleanDatabase } from '@/lib/testing/db';
import { ingestWhatsAppMessage } from '@/lib/tickets/ingest-whatsapp';
import { parseCoexistence } from '@/lib/whatsapp/coexistence';
import { processWebhook } from './process-webhook';

/**
 * A coexistence number's deliveries, from the stored row to what an agent and
 * a report see — through the real parser and the real dispatcher, because the
 * field name deciding what `messages` means is a fact about this seam that no
 * test of either half alone can see.
 */

withCleanDatabase();

const NUMBER = '106540352242922';
const RECEIVED = new Date('2026-10-08T12:00:00Z');

async function coexistenceChannel() {
  const [row] = await db
    .insert(channels)
    .values({
      type: 'whatsapp',
      name: 'ShipBlu on the phone',
      config: {
        phoneNumberId: NUMBER,
        coexistence: {
          onboardedAt: '2026-10-08T11:00:00.000Z',
          wabaId: '102290129340398',
          syncs: {},
        },
      },
    })
    .returning({ id: channels.id });
  return row!.id;
}

async function deliver(payload: unknown, receivedAt = RECEIVED): Promise<string> {
  const [event] = await db
    .insert(webhookEvents)
    .values({
      provider: 'whatsapp',
      channel: 'whatsapp',
      payload: payload as Record<string, unknown>,
      signatureVerified: true,
      receivedAt,
    })
    .returning({ id: webhookEvents.id });
  await processWebhook({
    id: 'job-1',
    type: 'process_webhook',
    payload: { webhookEventId: event!.id },
  } as unknown as ClaimedJob);
  return event!.id;
}

const value = (field: string, body: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '102290129340398',
      changes: [
        {
          field,
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550783881', phone_number_id: NUMBER },
            ...body,
          },
        },
      ],
    },
  ],
});

/** Meta's example, its instants moved to the day the report below measures. */
const history = (at: DateTime) =>
  value('history', {
    history: [
      {
        metadata: { phase: 0, chunk_order: 1, progress: 100 },
        threads: [
          {
            id: '16505551234',
            messages: [
              {
                from: '15550783881',
                id: 'wamid.history-1',
                timestamp: String(at.toSeconds()),
                type: 'media_placeholder',
                history_context: { status: 'PLAYED' },
              },
              {
                from: '16505551234',
                id: 'wamid.history-2',
                timestamp: String(at.plus({ minutes: 1 }).toSeconds()),
                type: 'text',
                text: { body: 'Thanks!' },
                history_context: { status: 'READ' },
              },
            ],
          },
        ],
      },
    ],
  });

describe('processWhatsAppWebhook: a number on the WhatsApp Business app', () => {
  it('imports a history chunk, then names the file a later delivery describes', async () => {
    const channelId = await coexistenceChannel();
    const at = DateTime.fromISO('2026-10-08T09:00:00', { zone: 'Africa/Cairo' });

    const eventId = await deliver(history(at));
    await deliver(
      value('history', {
        messages: [
          {
            from: '16505551234',
            id: 'wamid.history-1',
            timestamp: String(at.toSeconds()),
            type: 'image',
            image: { caption: 'The label', mime_type: 'image/jpeg', id: '24230790383178626' },
          },
        ],
      }),
    );

    const [ticket] = await db
      .select({ id: conversations.id, sourceSystem: conversations.sourceSystem })
      .from(conversations);
    expect(ticket?.sourceSystem).toBe('import');
    const rows = await db
      .select({ wamid: messages.channelMessageId, bodyText: messages.bodyText })
      .from(messages)
      .where(eq(messages.conversationId, ticket!.id))
      .orderBy(messages.createdAt);
    expect(rows).toEqual([
      { wamid: 'wamid.history-1', bodyText: expect.stringContaining('The label') },
      { wamid: 'wamid.history-2', bodyText: 'Thanks!' },
    ]);
    // Neither delivery queued anything: no download for the file, no linking,
    // no automation for the customer's words.
    expect(await db.select({ type: jobs.type }).from(jobs)).toEqual([]);

    const [event] = await db
      .select({ processedAt: webhookEvents.processedAt, error: webhookEvents.error })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, eventId));
    expect(event).toMatchObject({ error: null });
    const [row] = await db
      .select({ config: channels.config })
      .from(channels)
      .where(eq(channels.id, channelId));
    expect(parseCoexistence(row!.config)?.syncs.history).toMatchObject({
      chunks: 1,
      progressByPhase: { '0': 100 },
    });
  });

  it('adds an address-book contact and marks a disconnected phone, in one batch each', async () => {
    const channelId = await coexistenceChannel();

    await deliver(
      value('smb_app_state_sync', {
        state_sync: [
          {
            type: 'contact',
            contact: {
              full_name: 'Pablo Morales',
              first_name: 'Pablo',
              phone_number: '16505551234',
            },
            action: 'add',
            metadata: { timestamp: '1739321024' },
          },
        ],
      }),
    );
    await deliver({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          time: 1739212624,
          changes: [
            {
              field: 'account_update',
              value: {
                phone_number: '15550783881',
                event: 'PARTNER_REMOVED',
                disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
              },
            },
          ],
        },
      ],
    });

    const [row] = await db
      .select({ config: channels.config })
      .from(channels)
      .where(eq(channels.id, channelId));
    const coexistence = parseCoexistence(row!.config);
    expect(coexistence?.syncs.contacts).toMatchObject({ received: 1 });
    expect(coexistence?.disconnected).toMatchObject({ event: 'PARTNER_REMOVED' });
  });

  it('keeps an import out of the day it is dated, and a live ticket in it', async () => {
    await coexistenceChannel();
    const context = await reportingContext();
    // Today, because a live ticket is created now: its row takes the clock's
    // instant, not the message's.
    const day = DateTime.now().setZone(context.zone);

    // The phone's last day lands with today's instants.
    await deliver(history(day.startOf('day').plus({ minutes: 1 })));
    await ingestWhatsAppMessage({
      wamid: 'wamid.live',
      from: '201001234567',
      phoneNumberId: NUMBER,
      profileName: 'Amira',
      sentAt: day.toJSDate(),
      type: 'text',
      text: 'Where is my parcel?',
      media: null,
      location: null,
      replyToWamid: null,
      raw: { id: 'wamid.live' },
    });

    const slices = await computeDay(day.toISODate()!, context);
    // The all-dimensions row: one ticket, the live one.
    const total = slices.find(
      (slice) => slice.channel === null && slice.groupId === null && slice.agentId === null,
    );
    expect(total?.bucket.ticketsCreated).toBe(1);

    // And the archive is not said to start months early because of one.
    await deliver(
      value('history', {
        history: [
          {
            metadata: { phase: 2, chunk_order: 1, progress: 10 },
            threads: [
              {
                id: '12125557890',
                messages: [
                  {
                    from: '12125557890',
                    id: 'wamid.april',
                    timestamp: String(DateTime.fromISO('2026-04-02T10:00:00Z').toSeconds()),
                    type: 'text',
                    text: { body: 'Hello?' },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(await earliestDay(context.zone)).toBe(day.toISODate());
  });
});
