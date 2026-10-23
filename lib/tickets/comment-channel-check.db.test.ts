import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, ticketStatuses } from '@/db/schema';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * Stage 1.3's CHECK against real Postgres, as `db/sql/008_comment_channel_check.sql`
 * adds it (once, guarded on `pg_constraint`): the shapes it refuses, and the
 * shapes every writer produces, which it must accept.
 *
 * Asserted by code and constraint name rather than by "it threw", so a fixture
 * that fails for some other reason (a missing status, a foreign key) cannot
 * pass for the CHECK doing its job.
 */

withCleanDatabase();

const CONSTRAINT = 'conversations_comment_channel_matches_external_id';

async function insert(channel: ConversationChannel, externalId: string | null) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  return db.insert(conversations).values({
    channel,
    externalId,
    statusId: status!.id,
    requesterContactId: contact!.id,
  });
}

/** What Postgres said, from under drizzle's wrapper, or null if it said nothing. */
async function refusal(write: Promise<unknown>) {
  try {
    await write;
    return null;
  } catch (error) {
    const cause = ((error as { cause?: unknown }).cause ?? error) as {
      code?: string;
      constraint_name?: string;
    };
    return { code: cause.code, constraint: cause.constraint_name };
  }
}

describe('the comment channel CHECK', () => {
  // Each is a ticket some reader would answer wrongly: a public comment taken
  // for a private message, or a reply sent to the wrong platform's Graph host.
  const refused: [string, ConversationChannel, string | null][] = [
    ['a platform channel holding a comment', 'facebook', 'facebook:comment:post-1_c1'],
    ['a comment channel with no comment', 'facebook_comment', null],
    ['a comment channel with a direct message id', 'instagram_comment', 'instagram:psid-1'],
    [
      'a comment channel holding the other platform’s comment',
      'facebook_comment',
      'instagram:comment:17890',
    ],
    ['a comment with no root', 'instagram_comment', 'instagram:comment:'],
    ['a comment id on a channel that is not Meta’s', 'email', 'facebook:comment:post-1_c1'],
    ['an empty root off a comment channel', 'instagram', 'instagram:comment:'],
  ];

  for (const [name, channel, externalId] of refused) {
    it(`refuses ${name}`, async () => {
      expect(await refusal(insert(channel, externalId))).toEqual({
        code: '23514',
        constraint: CONSTRAINT,
      });
    });
  }

  // What ingest and the console write: a comment on its own platform's comment
  // channel, a direct message or an email with whatever id it carries, and the
  // tickets that carry none.
  const accepted: [string, ConversationChannel, string | null][] = [
    ['a Facebook comment', 'facebook_comment', 'facebook:comment:post-1_c1'],
    ['an Instagram comment', 'instagram_comment', 'instagram:comment:17890'],
    ['a Facebook direct message', 'facebook', null],
    ['an Instagram direct message', 'instagram', null],
    ['an email thread', 'email', '<abc@mail.example>'],
    ['a portal ticket', 'portal', null],
  ];

  for (const [name, channel, externalId] of accepted) {
    it(`accepts ${name}`, async () => {
      expect(await refusal(insert(channel, externalId))).toBeNull();
    });
  }

  // The CHECK reads the row as written, so moving a ticket onto a comment
  // channel without its id is refused too, not only creating one.
  it('refuses an update that splits the pair', async () => {
    await insert('facebook', null);
    expect(await refusal(db.update(conversations).set({ channel: 'facebook_comment' }))).toEqual({
      code: '23514',
      constraint: CONSTRAINT,
    });
  });
});
