import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, messageKindEnum, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { isReaction } from '@/lib/whatsapp/reaction';
import { notReaction } from './not-reaction';

/**
 * The two spellings of one rule — `notReaction()` for a query, `isReaction()`
 * over rows already in hand — held to the same answer on the same rows. A
 * ticket page picks the composer's anchor with one and the server picks the
 * suggestion's with the other, so a row they disagree on is a suggestion that
 * never shows.
 *
 * Every kind against every shape of `meta`: a reaction is its kind, or — for
 * the rows stored before it had one — a `reply` carrying the tag.
 */

withCleanDatabase();

/** Every shape `meta` takes in practice, and the odd ones a careless edit would split on. */
const METAS: Record<string, unknown>[] = [
  { whatsappType: 'reaction' },
  { whatsappType: 'reaction', echo: true, echoSource: 'business_app' },
  { whatsappType: 'text' },
  { whatsappType: 'Reaction' },
  { whatsappType: null },
  { whatsappType: ['reaction'] },
  { whatsappType: { type: 'reaction' } },
  { metaKind: 'direct_message', platform: 'facebook' },
  { isAutoReply: true },
  {},
];

describe('notReaction and isReaction', () => {
  it('keep and leave out exactly the same rows', async () => {
    const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const [conversation] = await db
      .insert(conversations)
      .values({ channel: 'whatsapp', statusId: open!.id, requesterContactId: contact!.id })
      .returning({ id: conversations.id });

    const rows = await db
      .insert(messages)
      .values(
        messageKindEnum.enumValues.flatMap((kind) =>
          METAS.map((meta, index) => ({
            conversationId: conversation!.id,
            direction: 'inbound' as const,
            kind,
            bodyText: `${kind} ${index}`,
            meta,
          })),
        ),
      )
      .returning({ id: messages.id, kind: messages.kind, meta: messages.meta });

    const kept = await db.select({ id: messages.id }).from(messages).where(notReaction());

    expect(new Set(kept.map((row) => row.id))).toEqual(
      new Set(rows.filter((row) => !isReaction(row)).map((row) => row.id)),
    );
    // And the rule is the one meant: every `reaction` row, and of the rest the
    // two carrying the tag — whatever their kind, which only `reply` ever is.
    const reactions = rows.filter((row) => isReaction(row));
    expect(reactions).toHaveLength(METAS.length + 2 * (messageKindEnum.enumValues.length - 1));
    expect(reactions.filter((row) => row.kind !== 'reaction')).toHaveLength(
      2 * (messageKindEnum.enumValues.length - 1),
    );
  });
});
