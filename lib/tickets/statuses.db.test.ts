import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { ingestInboundEmail } from './ingest';
import { defaultOpenStatusId, requireDefaultOpenStatusId } from './statuses';

/**
 * The status a new ticket opens in, and the one refusal every insert path
 * shares when there is none.
 */

withCleanDatabase();

const NO_STATUS = 'No default open ticket status configured — run `npm run db:seed`';

async function openStatusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status named ${name}`);
  return row.id;
}

describe('requireDefaultOpenStatusId', () => {
  it('is the seeded default', async () => {
    const id = await requireDefaultOpenStatusId(db);

    expect(id).toBe(await openStatusId('Open'));
    expect(id).toBe(await defaultOpenStatusId(db));
  });

  it('falls back to the lowest-positioned open status when none is marked default', async () => {
    await db.update(ticketStatuses).set({ isDefault: false });
    // Ahead of the seeded Open (position 1), and inserted after it: only the
    // ordering by position, not the order of insertion, picks this one.
    const [triage] = await db
      .insert(ticketStatuses)
      .values({ name: 'Triage', category: 'open', stopsSlaClock: false, position: 0 })
      .returning({ id: ticketStatuses.id });

    expect(await requireDefaultOpenStatusId(db)).toBe(triage!.id);
  });

  it('refuses, naming the command that fixes it, when there is no open status', async () => {
    await db.delete(ticketStatuses).where(eq(ticketStatuses.category, 'open'));

    expect(await defaultOpenStatusId(db)).toBeNull();
    await expect(requireDefaultOpenStatusId(db)).rejects.toThrow(NO_STATUS);
  });

  it('is the refusal an insert path meets, and it writes no ticket and no message', async () => {
    await db.delete(ticketStatuses).where(eq(ticketStatuses.category, 'open'));

    await expect(
      ingestInboundEmail({
        messageId: 'no-status@customer.example',
        references: [],
        from: { address: 'amira@customer.example', name: 'Amira' },
        to: [{ address: 'support@shipblu.test' }],
        cc: [],
        subject: 'Where is my parcel?',
        textBody: 'Hello.',
        attachments: [],
        headers: {},
        dateHeader: null,
        receivedAt: new Date('2026-09-20T10:00:00Z'),
      }),
    ).rejects.toThrow(NO_STATUS);
    expect(await db.$count(conversations)).toBe(0);
    expect(await db.$count(messages)).toBe(0);
    // Recorded, not endorsed: the sender is resolved before the transaction
    // opens, so the contact is already committed when the refusal comes. The
    // next mail from the same address reuses it.
    expect(await db.$count(contacts)).toBe(1);
  });
});
