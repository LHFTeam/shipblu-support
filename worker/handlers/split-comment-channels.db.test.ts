import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
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

async function channelRow(
  type: ConversationChannel,
  name: string,
  options: { isActive?: boolean; createdAt?: Date } = {},
) {
  const [row] = await db
    .insert(channels)
    .values({
      type,
      name,
      config: {},
      isActive: options.isActive ?? true,
      createdAt: options.createdAt ?? new Date('2026-09-01T00:00:00Z'),
    })
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
    const instagramRow = await channelRow('instagram', 'Instagram');
    // An inactive comments row routes nothing, so it is never landed on; of two
    // active ones the oldest wins, as `channelFor` in ingest picks.
    await channelRow('facebook_comment', 'Old Facebook comments', {
      isActive: false,
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const facebookComments = await channelRow('facebook_comment', 'Facebook comments', {
      createdAt: new Date('2026-09-10T00:00:00Z'),
    });
    await channelRow('facebook_comment', 'Newer Facebook comments', {
      createdAt: new Date('2026-10-10T00:00:00Z'),
    });

    const fbComment = await ticket({
      channel: 'facebook',
      externalId: 'facebook:comment:post-1_c1',
      channelId: facebookRow,
    });
    // Instagram has no comments row: one ticket predates the channel rows, the
    // other keeps the platform row it was filed against.
    const igComment = await ticket({
      channel: 'instagram',
      externalId: 'instagram:comment:17890',
    });
    const igCommentOnRow = await ticket({
      channel: 'instagram',
      externalId: 'instagram:comment:17892',
      channelId: instagramRow,
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
      instagramRow,
      facebookComments,
      fbComment,
      igComment,
      igCommentOnRow,
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
    expect(await ticketState(a.igCommentOnRow)).toEqual({
      channel: 'instagram_comment',
      channelId: a.instagramRow,
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

  // A copy written on the old channel by a request that read the ticket before
  // it moved: the next run catches it, because copies are matched by their
  // ticket's channel as it stands, not by what this run moved.
  it('moves a copy left behind on a ticket that has already moved', async () => {
    const moved = await ticket({
      channel: 'instagram_comment',
      externalId: 'instagram:comment:17891',
    });
    const behind = await suggestion(moved, 'instagram');

    await splitCommentChannels(job());

    expect(await suggestionChannel(behind)).toBe('instagram_comment');
  });

  // The dry run is what the runbook reads before writing, and what says there
  // is nothing left before 1.3 adds its CHECK, so its figures are pinned to the
  // real run's.
  it('reports on a dry run what the real run then moves, and nothing after', async () => {
    await archive();
    const lines = vi.spyOn(console, 'log').mockImplementation(() => {});
    const said = () => lines.mock.calls.map((call) => String(call[0]));

    await splitCommentChannels(job({ dryRun: true }));
    expect(said()).toEqual([
      '[split_comment_channels] facebook: 2 tickets would move to facebook_comment, 2 onto a comments row',
      '[split_comment_channels] instagram: 2 tickets would move to instagram_comment, 0 onto a comments row',
      '[split_comment_channels] dry run: 4 comment tickets, 1 csat_surveys and 1 canned_suggestions would move',
    ]);

    lines.mockClear();
    await splitCommentChannels(job());
    expect(said()).toEqual([
      '[split_comment_channels] facebook: 2 tickets moved to facebook_comment, 2 onto a comments row',
      '[split_comment_channels] instagram: 2 tickets moved to instagram_comment, 0 onto a comments row',
      '[split_comment_channels] 4 comment tickets, 1 csat_surveys and 1 canned_suggestions moved',
    ]);

    lines.mockClear();
    await splitCommentChannels(job({ dryRun: true }));
    expect(said()).toEqual([
      '[split_comment_channels] dry run: 0 comment tickets, 0 csat_surveys and 0 canned_suggestions would move',
    ]);
    lines.mockRestore();
  });

  it('refuses an option it does not know, rather than running without it', async () => {
    await expect(splitCommentChannels(job({ dryrun: true }))).rejects.toThrow();
  });
});
