import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contacts,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * `009_whatsapp_channel_backfill.sql`, run as `db/migrate.ts` runs it: the
 * file's own text, executed, and executed again.
 *
 * The CI replay proves the statement plans and survives a second run on an
 * empty database, where it matches nothing. This is the half that needs rows:
 * that it picks the number a ticket was really on, and that a replay — which
 * happens on every deploy — never moves a ticket a second time.
 */

withCleanDatabase();

const backfill = readFileSync(
  new URL('./009_whatsapp_channel_backfill.sql', import.meta.url),
  'utf8',
);

const run = () => db.execute(sql.raw(backfill));

const SUPPORT = '838961722630554';
const PHONE = '106540352242922';
const BOT = '128318316834446';

async function openStatus(): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  return row!.id;
}

async function number(
  name: string,
  phoneNumberId: string,
  extra: Partial<typeof channels.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(channels)
    .values({ type: 'whatsapp', name, config: { phoneNumberId }, ...extra })
    .returning({ id: channels.id });
  return row!.id;
}

async function ticket(overrides: Partial<typeof conversations.$inferInsert> = {}) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'whatsapp',
      statusId: await openStatus(),
      requesterContactId: contact!.id,
      lastMessageAt: new Date('2026-09-20T10:00:00Z'),
      ...overrides,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

let sequence = 0;

/** A WhatsApp message on a ticket, as ingest stores one: the number in `meta.phoneNumberId`. */
async function message(
  conversationId: string,
  phoneNumberId: string,
  at: string,
  shape: { direction?: 'inbound' | 'outbound'; whatsappType?: string } = {},
) {
  await db.insert(messages).values({
    conversationId,
    direction: shape.direction ?? 'inbound',
    kind: 'reply',
    bodyText: 'Where is my parcel?',
    channelMessageId: `wamid.${++sequence}`,
    meta: { whatsappType: shape.whatsappType ?? 'text', phoneNumberId },
    createdAt: new Date(`2026-09-20T${at}:00Z`),
  });
}

async function channelOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ channelId: conversations.channelId })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.channelId;
}

describe('009_whatsapp_channel_backfill.sql', () => {
  it('files a ticket with no row under the number its newest inbound message reached', async () => {
    const support = await number('WhatsApp Support', SUPPORT);
    const phone = await number('Nayera', PHONE);
    const id = await ticket();
    await message(id, SUPPORT, '09:00');
    await message(id, PHONE, '09:30');
    // Newer, but not what the customer wrote to: a reaction is filed on a
    // ticket rather than threading it, and our own reply is not their number.
    await message(id, SUPPORT, '10:00', { whatsappType: 'reaction' });
    await message(id, SUPPORT, '10:30', { direction: 'outbound' });

    await run();

    expect(await channelOf(id)).toBe(phone);
    expect(await channelOf(id)).not.toBe(support);
  });

  // Production's ticket #1 carries messages to the bot's number and the
  // support number. It is a support ticket, and goes to the support number.
  it('never files a ticket under the bot, even when its newest message reached the bot', async () => {
    const support = await number('WhatsApp Support', SUPPORT);
    const id = await ticket();
    await message(id, SUPPORT, '09:00');
    await message(id, BOT, '09:30');

    await run();

    expect(await channelOf(id)).toBe(support);
  });

  it('prefers an active row where two name the same number', async () => {
    await number('Retired', SUPPORT, {
      isActive: false,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const live = await number('WhatsApp Support', SUPPORT, {
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    const id = await ticket();
    await message(id, SUPPORT, '09:00');

    await run();

    expect(await channelOf(id)).toBe(live);
  });

  // The resolver threads only on active rows, so a ticket placed under an
  // inactive one is out of its customer's reach: their next message, still
  // filed under no row, would open another beside it, and every deploy would
  // strand one more.
  it('never places a ticket under an inactive row', async () => {
    await number('Retired', SUPPORT, { isActive: false });
    const id = await ticket();
    await message(id, SUPPORT, '09:00');

    await run();

    expect(await channelOf(id)).toBeNull();
  });

  // The support row exists, so each ticket below that names its number would be
  // placed there if the statement reached it.
  it('leaves alone what it cannot place, and what is already placed', async () => {
    await number('WhatsApp Support', SUPPORT);
    const phone = await number('Nayera', PHONE);
    const nowhere = await ticket();
    await message(nowhere, '100000000000001', '09:00');
    const silent = await ticket();
    const placed = await ticket({ channelId: phone });
    await message(placed, SUPPORT, '09:00');
    const bot = await ticket({ channel: 'whatsapp_bot' });
    await message(bot, SUPPORT, '09:00');

    await run();

    expect(await channelOf(nowhere)).toBeNull();
    expect(await channelOf(silent)).toBeNull();
    expect(await channelOf(placed)).toBe(phone);
    expect(await channelOf(bot)).toBeNull();
  });

  /**
   * A coexistence row's tickets are its owner's alone
   * (`lib/tickets/owner-only.ts`), so a ticket filed under one is not left
   * with whoever held it while it was nobody's number's. SQL cannot ask who
   * sees every ticket, so only the number's active owner keeps one.
   */
  describe('filing under a coexistence number', () => {
    const COEXISTENCE = { onboardedAt: '2026-10-01T09:00:00.000Z', wabaId: '1' };
    let people = 0;

    async function person(values: Partial<typeof agents.$inferInsert> = {}) {
      people += 1;
      const [row] = await db
        .insert(agents)
        .values({ name: `Agent ${people}`, email: `backfill${people}@shipblu.test`, ...values })
        .returning({ id: agents.id });
      return row!.id;
    }

    const phone = (ownerAgentId: string | null) =>
      db
        .insert(channels)
        .values({
          type: 'whatsapp',
          name: 'Nayera',
          ownerAgentId,
          config: { phoneNumberId: PHONE, coexistence: COEXISTENCE },
        })
        .returning({ id: channels.id })
        .then((rows) => rows[0]!.id);

    async function heldTicket(holder: string | null) {
      const id = await ticket(
        holder ? { assigneeAgentId: holder, assignedAt: new Date('2026-09-20T10:00:00Z') } : {},
      );
      await message(id, PHONE, '09:00');
      return id;
    }

    async function held(id: string) {
      const [row] = await db
        .select({
          channelId: conversations.channelId,
          assigneeAgentId: conversations.assigneeAgentId,
          assignedAt: conversations.assignedAt,
        })
        .from(conversations)
        .where(eq(conversations.id, id));
      const lines = await db
        .select({
          type: conversationEvents.type,
          actorLabel: conversationEvents.actorLabel,
          data: conversationEvents.data,
        })
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, id));
      return { ...row!, lines };
    }

    it('gives a ticket a colleague holds to nobody, and says why', async () => {
      const owner = await person();
      const colleague = await person();
      const channelId = await phone(owner);
      const id = await heldTicket(colleague);

      await run();

      expect(await held(id)).toEqual({
        channelId,
        assigneeAgentId: null,
        assignedAt: null,
        lines: [
          {
            type: 'unassigned',
            actorLabel: 'channel_backfill',
            data: { to: null, from: colleague, reason: 'filed_under_number_at_deploy', channelId },
          },
        ],
      });
    });

    it('leaves one with the number’s active owner, and writes no line for one nobody held', async () => {
      const owner = await person();
      const channelId = await phone(owner);
      const theirs = await heldTicket(owner);
      const nobodys = await heldTicket(null);

      await run();

      expect(await held(theirs)).toMatchObject({ channelId, assigneeAgentId: owner, lines: [] });
      expect(await held(nobodys)).toMatchObject({ channelId, assigneeAgentId: null, lines: [] });
    });

    // A deactivated owner counts as nobody (`effectiveOwnerId`), and with no
    // owner at all nobody but an agent who sees every ticket can open it.
    it('takes one off anybody when the number has no owner', async () => {
      const colleague = await person();
      const channelId = await phone(null);
      const id = await heldTicket(colleague);

      await run();

      expect(await held(id)).toMatchObject({ channelId, assigneeAgentId: null, assignedAt: null });
      expect((await held(id)).lines).toHaveLength(1);
    });

    // Where `fileUnderNumber` lets her keep it: SQL cannot ask who sees every
    // ticket, and nobody is somebody every ticket may be left with.
    it('takes one off an agent who sees every ticket, which only TypeScript can ask', async () => {
      const owner = await person();
      const supervisor = await person({ role: 'supervisor' });
      const channelId = await phone(owner);
      const id = await heldTicket(supervisor);

      await run();

      expect(await held(id)).toMatchObject({ channelId, assigneeAgentId: null });
      expect((await held(id)).lines).toMatchObject([
        { data: { from: supervisor, reason: 'filed_under_number_at_deploy' } },
      ]);
    });

    it('takes one off a deactivated owner, whom the number counts as nobody', async () => {
      const gone = await person({ isActive: false });
      const channelId = await phone(gone);
      const id = await heldTicket(gone);

      await run();

      expect(await held(id)).toMatchObject({ channelId, assigneeAgentId: null, assignedAt: null });
      expect((await held(id)).lines).toHaveLength(1);
    });

    it('leaves a colleague holding a ticket filed under a plain number', async () => {
      const colleague = await person();
      const support = await number('WhatsApp Support', SUPPORT);
      const id = await ticket({ assigneeAgentId: colleague });
      await message(id, SUPPORT, '09:00');

      await run();

      expect(await held(id)).toMatchObject({
        channelId: support,
        assigneeAgentId: colleague,
        lines: [],
      });
    });

    // A handover holds the number's row FOR UPDATE. A replay with nothing to
    // file there must not wait for it — a ticket under no row whose number
    // has none is there on every deploy — and one with a ticket to file must,
    // so that the owner it reads is the one the handover leaves.
    it('waits for a handover only on a number it has a ticket to file under', async () => {
      const owner = await person();
      const channelId = await phone(owner);
      const unplaceable = await ticket();
      await message(unplaceable, '100000000000001', '09:00');

      const other = postgres(process.env.TEST_DATABASE_URL!, {
        max: 1,
        prepare: false,
        onnotice: () => {},
      });
      const replay = () =>
        db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '300ms'`);
          await tx.execute(sql.raw(backfill));
        });
      try {
        await other.begin(async (handover) => {
          await handover`select id from channels where id = ${channelId} for update`;
          await expect(replay()).resolves.toBeUndefined();

          await message(await heldTicket(null), PHONE, '10:00');
          await expect(replay()).rejects.toMatchObject({ cause: { code: '55P03' } });
        });
      } finally {
        await other.end();
      }
    });

    // Once filed, the ticket is on a row, and a replay reads only tickets on
    // none: somebody given it since — its owner, a supervisor — keeps it.
    it('writes nothing the second time, and never touches a ticket already on the row', async () => {
      const owner = await person();
      const colleague = await person();
      const supervisor = await person({ role: 'supervisor' });
      const channelId = await phone(owner);
      const id = await heldTicket(colleague);
      const placed = await ticket({ channelId, assigneeAgentId: colleague });
      await message(placed, PHONE, '09:00');

      await run();
      await db
        .update(conversations)
        .set({ assigneeAgentId: supervisor })
        .where(eq(conversations.id, id));
      await run();

      expect(await held(id)).toMatchObject({ assigneeAgentId: supervisor });
      expect((await held(id)).lines).toHaveLength(1);
      expect(await held(placed)).toMatchObject({ assigneeAgentId: colleague, lines: [] });
    });
  });

  // Replayed after every migration, so a second run must write nothing — not
  // even the same value, which would still touch `updated_at` and wake every
  // console watching the ticket.
  it('changes nothing the second time', async () => {
    await number('WhatsApp Support', SUPPORT);
    await number('Nayera', PHONE);
    const moved = await ticket();
    await message(moved, PHONE, '09:00');
    const stays = await ticket();
    await message(stays, '100000000000001', '09:00');

    await run();
    const first = await snapshot();
    await run();

    expect(await snapshot()).toEqual(first);
    expect(first.find((row) => row.id === moved)?.channelId).not.toBeNull();
  });
});

async function snapshot() {
  return db
    .select({
      id: conversations.id,
      channelId: conversations.channelId,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .orderBy(asc(conversations.id));
}
