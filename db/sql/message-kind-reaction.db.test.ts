import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * `007_message_kind_reaction.sql` exists for rows that are already there, so
 * the database job replaying it over an empty database proves only that it
 * parses. Here it runs over the shapes it has to tell apart — the rows stored
 * before reactions had a kind, and the ones that only look like them — exactly
 * as `db/migrate.ts` sends it, and then again, because every deploy does.
 */

withCleanDatabase();

const backfill = readFileSync(new URL('./007_message_kind_reaction.sql', import.meta.url), 'utf8');

describe('007_message_kind_reaction.sql', () => {
  it('moves a reaction stored as a reply, from either side, and nothing else — once', async () => {
    const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const [conversation] = await db
      .insert(conversations)
      .values({ channel: 'whatsapp', statusId: open!.id, requesterContactId: contact!.id })
      .returning({ id: conversations.id });

    const row = (
      bodyText: string,
      meta: Record<string, unknown>,
      direction: 'inbound' | 'outbound' = 'inbound',
    ) => ({ conversationId: conversation!.id, direction, kind: 'reply' as const, bodyText, meta });

    await db.insert(messages).values([
      // What ingest stored before this release: the customer's, the business
      // app's echo, and one taken back, which has no emoji.
      row('[reacted 🙏]', { whatsappType: 'reaction', phoneNumberId: 'pn' }),
      row('[reacted ❤️]', { whatsappType: 'reaction', echo: true }, 'outbound'),
      row('[reacted]', { whatsappType: 'reaction' }),
      // Words that only look like one.
      row('[reacted] — that was me, sorry', { whatsappType: 'text' }),
      row('[reacted 👍] in an email', {}),
      row('where is my parcel', { whatsappType: 'text' }),
    ]);

    const kinds = async () =>
      db
        .select({ bodyText: messages.bodyText, kind: messages.kind, meta: messages.meta })
        .from(messages)
        // Byte order, which the list below is written in: the database's own
        // collation is the cluster's locale, and under en_US.utf8 — CI's —
        // brackets and spaces are ignored at the first level.
        .orderBy(sql`${messages.bodyText} collate "C"`);

    await db.execute(sql.raw(backfill));
    const once = await kinds();

    expect(once.map(({ bodyText, kind }) => [bodyText, kind])).toEqual([
      ['[reacted ❤️]', 'reaction'],
      ['[reacted 👍] in an email', 'reply'],
      ['[reacted 🙏]', 'reaction'],
      ['[reacted]', 'reaction'],
      ['[reacted] — that was me, sorry', 'reply'],
      ['where is my parcel', 'reply'],
    ]);
    // The tag stays, so the code before this change still knows them after a
    // rollback.
    expect(once.filter((m) => m.kind === 'reaction').map((m) => m.meta.whatsappType)).toEqual([
      'reaction',
      'reaction',
      'reaction',
    ]);

    await db.execute(sql.raw(backfill));
    expect(await kinds()).toEqual(once);
  });
});
