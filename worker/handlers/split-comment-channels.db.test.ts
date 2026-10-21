import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  cannedSuggestions,
  channels,
  contacts,
  conversations,
  csatSurveys,
  ticketStatuses,
} from '@/db/schema';
import type { ClaimedJob } from '@/lib/queue';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import { withCleanDatabase } from '@/lib/testing/db';
import { splitCommentChannels } from './split-comment-channels';

/**
 * Stage 1.2's backfill against real Postgres: which tickets move, where their
 * `channel_id` lands, which frozen copies follow them, and that a second run
 * finds nothing — the property that lets it be run again until a dry run
 * reports nothing left.
 */

withCleanDatabase();

function job(payload: Record<string, unknown> = {}): ClaimedJob {
  return { id: 'job-1', type: 'split_comment_channels', payload } as unknown as ClaimedJob;
}

async function ticket(input: {
  channel: ConversationChannel;
  externalId?: string | null;
  channelId?: string | null;
  deleted?: boolean;
}): Promise<string> {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .insert(conversations)
    .values({
      channel: input.channel,
      externalId: input.externalId ?? null,
      channelId: input.channelId ?? null,
      statusId: status!.id,
      requesterContactId: contact!.id,
      deletedAt: input.deleted ? new Date('2026-10-01T00:00:00Z') : null,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function channelRow(type: ConversationChannel, name: string, isActive = true) {
  const [row] = await db
    .insert(channels)
    .values({ type, name, config: {}, isActive })
    .returning({ id: channels.id });
  return row!.id;
}

async function suggestion(conversationId: string, channel: ConversationChannel) {
  const [row] = await db
    .insert(cannedSuggestions)
    .values({ conversationId, channel, requestVersion: 'test' })
    .returning({ id: cannedSuggestions.id });
  return row!.id;
}

async function survey(conversationId: string, channel: ConversationChannel) {
  const [row] = await db
    .insert(csatSurveys)
    .values({ conversationId, channel })
    .returning({ id: csatSurveys.id });
  return row!.id;
}

async function ticketState(id: string) {
  const [row] = await db
    .select({ channel: conversations.channel, channelId: conversations.channelId })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!;
}

async function suggestionChannel(id: string) {
  const [row] = await db
    .select({ channel: cannedSuggestions.channel })
    .from(cannedSuggestions)
    .where(eq(cannedSuggestions.id, id));
  return row!.channel;
}

async function surveyChannel(id: string) {
  const [row] = await db
    .select({ channel: csatSurveys.channel })
    .from(csatSurveys)
    .where(eq(csatSurveys.id, id));
  return row!.channel;
}

describe('splitCommentChannels', () => {
  async function archive() {
    const facebookRow = await channelRow('facebook', 'Facebook');
    // An inactive comments row routes nothing, so it is never landed on.
    await channelRow('facebook_comment', 'Old Facebook comments', false);
    const facebookComments = await channelRow('facebook_comment', 'Facebook comments');

    const fbComment = await ticket({
      channel: 'facebook',
      externalId: 'facebook:comment:post-1_c1',
      channelId: facebookRow,
    });
    // Predates the channel rows, and Instagram has no comments row yet.
    const igComment = await ticket({
      channel: 'instagram',
      externalId: 'instagram:comment:17890',
    });
    const deletedComment = await ticket({
      channel: 'facebook',
      externalId: 'facebook:comment:post-2_c1',
      deleted: true,
    });
    const dm = await ticket({ channel: 'facebook', channelId: facebookRow });
    const email = await ticket({
      channel: 'email',
      externalId: 'facebook:comment:not-a-meta-ticket',
    });

    return {
      facebookRow,
      facebookComments,
      fbComment,
      igComment,
      deletedComment,
      dm,
      email,
      copies: {
        fbSuggestion: await suggestion(fbComment, 'facebook'),
        igSurvey: await survey(igComment, 'instagram'),
        dmSuggestion: await suggestion(dm, 'facebook'),
        dmSurvey: await survey(dm, 'facebook'),
      },
    };
  }

  it('writes nothing on a dry run', async () => {
    const a = await archive();

    await splitCommentChannels(job({ dryRun: true }));

    expect(await ticketState(a.fbComment)).toEqual({
      channel: 'facebook',
      channelId: a.facebookRow,
    });
    expect(await ticketState(a.igComment)).toEqual({ channel: 'instagram', channelId: null });
    expect(await suggestionChannel(a.copies.fbSuggestion)).toBe('facebook');
    expect(await surveyChannel(a.copies.igSurvey)).toBe('instagram');
  });

  it('moves every comment ticket and its copies, and nothing else', async () => {
    const a = await archive();

    await splitCommentChannels(job());

    // Onto the active comments row where there is one; kept where there is not.
    expect(await ticketState(a.fbComment)).toEqual({
      channel: 'facebook_comment',
      channelId: a.facebookComments,
    });
    expect(await ticketState(a.igComment)).toEqual({
      channel: 'instagram_comment',
      channelId: null,
    });
    // Deleted tickets too: Stage 1.3's CHECK reads every row.
    expect((await ticketState(a.deletedComment)).channel).toBe('facebook_comment');

    expect(await suggestionChannel(a.copies.fbSuggestion)).toBe('facebook_comment');
    expect(await surveyChannel(a.copies.igSurvey)).toBe('instagram_comment');

    // A direct message and anything not on a Meta channel stay where they are.
    expect(await ticketState(a.dm)).toEqual({ channel: 'facebook', channelId: a.facebookRow });
    expect((await ticketState(a.email)).channel).toBe('email');
    expect(await suggestionChannel(a.copies.dmSuggestion)).toBe('facebook');
    expect(await surveyChannel(a.copies.dmSurvey)).toBe('facebook');
  });

  it('changes nothing the second time', async () => {
    const a = await archive();
    await splitCommentChannels(job());

    const before = await Promise.all([
      ticketState(a.fbComment),
      ticketState(a.igComment),
      ticketState(a.dm),
      suggestionChannel(a.copies.fbSuggestion),
      surveyChannel(a.copies.igSurvey),
    ]);

    await splitCommentChannels(job());

    expect(
      await Promise.all([
        ticketState(a.fbComment),
        ticketState(a.igComment),
        ticketState(a.dm),
        suggestionChannel(a.copies.fbSuggestion),
        surveyChannel(a.copies.igSurvey),
      ]),
    ).toEqual(before);
  });

  // A suggestion written by a web still on 1.1 after its ticket moved: the
  // next run catches it, because copies are matched by their ticket's channel
  // as it stands, not by what this run moved.
  it('moves a copy left behind on a ticket that has already moved', async () => {
    const moved = await ticket({
      channel: 'instagram_comment',
      externalId: 'instagram:comment:17891',
    });
    const behind = await suggestion(moved, 'instagram');

    await splitCommentChannels(job());

    expect(await suggestionChannel(behind)).toBe('instagram_comment');
  });

  it('refuses an option it does not know, rather than running without it', async () => {
    await expect(splitCommentChannels(job({ dryrun: true }))).rejects.toThrow();
  });
});
