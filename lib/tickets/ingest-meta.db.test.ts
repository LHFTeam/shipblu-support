import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  groups,
  jobs,
  messages,
  slaPolicies,
  ticketStatuses,
} from '@/db/schema';
import type {
  NormalisedComment,
  NormalisedDirectMessage,
  NormalisedInteraction,
} from '@/lib/meta/types';
import { withCleanDatabase, withoutCommentChannelCheck } from '@/lib/testing/db';
import { applyMetaInteraction, ingestMetaComment, ingestMetaMessage } from './ingest-meta';

/**
 * What the two Meta ingest paths write today, quirks included, so the shared
 * ingest steps of Stage 4.2 can be proven to change nothing.
 *
 * The two thread differently, and most of what is pinned here is that
 * difference: a direct message threads on the person, like WhatsApp; a comment
 * threads on the comment it belongs to, keyed in `external_id`, and the two
 * never meet. No Facebook or Instagram channel is seeded, so neither kind of
 * ticket carries a channel or a group, except where a test adds the rows.
 */

withCleanDatabase();

const PSID = '24681357902468135';
const SENT = new Date('2026-09-20T10:00:00Z');
const LATER = new Date('2026-09-20T11:30:00Z');

function dm(overrides: Partial<NormalisedDirectMessage> = {}): NormalisedDirectMessage {
  return {
    platform: 'facebook',
    connection: 'facebook_page',
    mid: 'm_first',
    from: PSID,
    accountId: 'page-1',
    standby: false,
    senderName: null,
    sentAt: SENT,
    text: 'Where is my parcel?\nOrder 5512',
    attachments: [],
    replyToMid: null,
    raw: { mid: 'm_first' },
    ...overrides,
  };
}

function comment(overrides: Partial<NormalisedComment> = {}): NormalisedComment {
  return {
    platform: 'facebook',
    connection: 'facebook_page',
    commentId: 'post-1_c1',
    parentCommentId: null,
    postId: 'post-1',
    from: '1122334455',
    fromName: 'Amira Hassan',
    text: 'My parcel never came',
    createdAt: SENT,
    verb: 'add',
    raw: { comment_id: 'post-1_c1' },
    ...overrides,
  };
}

async function conversation(id: string) {
  const [row] = await db
    .select({
      number: conversations.number,
      channel: conversations.channel,
      channelId: conversations.channelId,
      externalId: conversations.externalId,
      subject: conversations.subject,
      status: ticketStatuses.name,
      requesterContactId: conversations.requesterContactId,
      reopenCount: conversations.reopenCount,
      resolvedAt: conversations.resolvedAt,
      resolvedByAgentId: conversations.resolvedByAgentId,
      lastMessageAt: conversations.lastMessageAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, id));
  if (!row) throw new Error(`no conversation ${id}`);
  return row;
}

async function groupOf(id: string) {
  const [row] = await db
    .select({ groupId: conversations.groupId })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row?.groupId ?? null;
}

async function messagesOf(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

async function eventsOf(conversationId: string) {
  return db
    .select({
      type: conversationEvents.type,
      actorLabel: conversationEvents.actorLabel,
      data: conversationEvents.data,
    })
    .from(conversationEvents)
    .where(eq(conversationEvents.conversationId, conversationId))
    .orderBy(asc(conversationEvents.createdAt));
}

async function queued() {
  return db
    .select({
      type: jobs.type,
      payload: jobs.payload,
      priority: jobs.priority,
      dedupeKey: jobs.dedupeKey,
    })
    .from(jobs)
    .orderBy(asc(jobs.createdAt));
}

async function setStatus(conversationId: string, name: string, extra = {}) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!status) throw new Error(`no status ${name}`);
  await db
    .update(conversations)
    .set({ statusId: status.id, ...extra })
    .where(eq(conversations.id, conversationId));
}

/** Resolves a ticket the way an agent does: status, time and who. */
async function resolveAsAgent(conversationId: string): Promise<string> {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  if (!agent) throw new Error('no agent');
  await setStatus(conversationId, 'Resolved', {
    resolvedAt: new Date('2026-09-20T10:30:00Z'),
    resolvedByAgentId: agent.id,
  });
  return agent.id;
}

describe('ingestMetaMessage', () => {
  it('opens a ticket for a new sender, and asks Meta who they are', async () => {
    const result = await ingestMetaMessage(dm());

    expect(result).toMatchObject({
      conversationNumber: 1,
      createdConversation: true,
      duplicate: false,
    });

    const [contact] = await db.select().from(contacts);
    expect(await db.select().from(contactIdentities)).toMatchObject([
      { contactId: contact?.id, channel: 'facebook', identifier: PSID, profileFetchedAt: null },
    ]);

    expect(await conversation(result.conversationId)).toEqual({
      number: 1,
      channel: 'facebook',
      channelId: null,
      externalId: null,
      subject: 'Where is my parcel?',
      status: 'Open',
      requesterContactId: contact?.id,
      reopenCount: 0,
      resolvedAt: null,
      resolvedByAgentId: null,
      lastMessageAt: SENT,
      lastCustomerMessageAt: SENT,
    });

    expect(await messagesOf(result.conversationId)).toMatchObject([
      {
        id: result.messageId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contact?.id,
        bodyText: 'Where is my parcel?\nOrder 5512',
        bodyHtml: null,
        channelMessageId: 'm_first',
        fromAddress: PSID,
        deliveryStatus: 'delivered',
        deliveredAt: SENT,
        meta: {
          metaKind: 'direct_message',
          platform: 'facebook',
          accountId: 'page-1',
          connection: 'facebook_page',
          standby: false,
          attachments: [],
        },
      },
    ]);

    // No key, deliberately: see `queueProfileLookup`.
    expect(await queued()).toEqual([
      {
        type: 'fetch_meta_profile',
        payload: { contactId: contact?.id, platform: 'facebook', userId: PSID },
        priority: 20,
        dedupeKey: null,
      },
    ]);
    expect((await eventsOf(result.conversationId)).map((e) => e.type)).toEqual(['subcategorised']);
  });

  it('continues the sender’s live thread, and asks again while no profile has come back', async () => {
    const first = await ingestMetaMessage(dm());
    const second = await ingestMetaMessage(dm({ mid: 'm_second', text: 'Hello?', sentAt: LATER }));

    expect(second).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    expect(await conversation(first.conversationId)).toMatchObject({
      lastMessageAt: LATER,
      lastCustomerMessageAt: LATER,
    });
    // One lookup per message until one lands; the handler is what collapses them.
    expect((await queued()).map((job) => job.type)).toEqual([
      'fetch_meta_profile',
      'fetch_meta_profile',
    ]);
  });

  it('asks nothing once the profile has been fetched', async () => {
    await ingestMetaMessage(dm());
    await db.delete(jobs);
    await db.update(contactIdentities).set({ profileFetchedAt: SENT });

    await ingestMetaMessage(dm({ mid: 'm_second', sentAt: LATER }));

    expect(await queued()).toEqual([]);
  });

  it('queues a download per attachment that has a URL', async () => {
    const result = await ingestMetaMessage(
      dm({
        text: '',
        attachments: [
          { type: 'image', url: 'https://cdn.example/a.jpg', title: null },
          { type: 'share', url: null, title: 'A post' },
          { type: 'video', url: 'https://cdn.example/b.mp4', title: null },
        ],
      }),
    );

    expect((await conversation(result.conversationId)).subject).toBe('Facebook');
    expect((await queued()).filter((job) => job.type === 'download_media')).toEqual([
      {
        type: 'download_media',
        payload: {
          messageId: result.messageId,
          url: 'https://cdn.example/a.jpg',
          index: 0,
          source: 'meta',
        },
        priority: 5,
        dedupeKey: `download_media:${result.messageId}:0`,
      },
      {
        type: 'download_media',
        payload: {
          messageId: result.messageId,
          url: 'https://cdn.example/b.mp4',
          index: 2,
          source: 'meta',
        },
        priority: 5,
        dedupeKey: `download_media:${result.messageId}:2`,
      },
    ]);
  });

  it('reopens a resolved thread, labelled with the platform, naming who resolved it', async () => {
    const first = await ingestMetaMessage(
      dm({ platform: 'instagram', connection: 'instagram_login' }),
    );
    const resolver = await resolveAsAgent(first.conversationId);

    await ingestMetaMessage(
      dm({ platform: 'instagram', connection: 'instagram_login', mid: 'm_second', sentAt: LATER }),
    );

    expect(await conversation(first.conversationId)).toMatchObject({
      channel: 'instagram',
      status: 'Open',
      reopenCount: 1,
      resolvedAt: null,
      // Left for the event to read, as the email path leaves it.
      resolvedByAgentId: resolver,
    });
    expect((await eventsOf(first.conversationId)).filter((e) => e.type === 'reopened')).toEqual([
      {
        type: 'reopened',
        actorLabel: 'inbound_instagram',
        data: { reason: 'customer_replied', resolvedBy: resolver },
      },
    ]);
  });

  it('starts a new ticket after the last one was closed', async () => {
    const first = await ingestMetaMessage(dm());
    await setStatus(first.conversationId, 'Closed');

    const second = await ingestMetaMessage(dm({ mid: 'm_second', sentAt: LATER }));

    expect(second).toMatchObject({ createdConversation: true, conversationNumber: 2 });
  });

  it('writes nothing the second time a mid arrives', async () => {
    const first = await ingestMetaMessage(dm());
    const again = await ingestMetaMessage(dm());

    expect(again).toEqual({
      conversationId: first.conversationId,
      conversationNumber: 1,
      messageId: first.messageId,
      createdConversation: false,
      duplicate: true,
    });
    expect(await messagesOf(first.conversationId)).toHaveLength(1);
    expect(await queued()).toHaveLength(1);
  });
});

describe('ingestMetaComment', () => {
  it('opens a ticket per root comment, keyed in external_id', async () => {
    const result = await ingestMetaComment(comment());

    expect(result).toMatchObject({ createdConversation: true, duplicate: false });

    const [contact] = await db.select().from(contacts);
    expect(contact).toMatchObject({ name: 'Amira Hassan' });

    expect(await conversation(result.conversationId)).toMatchObject({
      channel: 'facebook_comment',
      channelId: null,
      externalId: 'facebook:comment:post-1_c1',
      subject: 'My parcel never came',
      status: 'Open',
      lastCustomerMessageAt: SENT,
    });
    expect(await messagesOf(result.conversationId)).toMatchObject([
      {
        direction: 'inbound',
        bodyText: 'My parcel never came',
        channelMessageId: 'post-1_c1',
        inReplyTo: null,
        fromAddress: '1122334455',
        meta: {
          metaKind: 'comment',
          platform: 'facebook',
          connection: 'facebook_page',
          commentId: 'post-1_c1',
          parentCommentId: null,
          postId: 'post-1',
          isPublic: true,
        },
      },
    ]);
    expect(await eventsOf(result.conversationId)).toMatchObject([
      {
        type: 'comment_thread_opened',
        actorLabel: 'inbound_facebook',
        data: { postId: 'post-1', rootCommentId: 'post-1_c1' },
      },
      { type: 'subcategorised' },
    ]);
    // A comment arrives with its author's name; nothing to look up.
    expect(await queued()).toEqual([]);
  });

  it('puts a reply on the ticket of the comment it answers', async () => {
    const root = await ingestMetaComment(comment());
    const reply = await ingestMetaComment(
      comment({
        commentId: 'post-1_c2',
        parentCommentId: 'post-1_c1',
        text: 'Any update?',
        createdAt: LATER,
      }),
    );

    expect(reply).toMatchObject({
      conversationId: root.conversationId,
      createdConversation: false,
    });
    const [, second] = await messagesOf(root.conversationId);
    expect(second).toMatchObject({ channelMessageId: 'post-1_c2', inReplyTo: 'post-1_c1' });
  });

  it('opens a second ticket for the same person commenting on another post', async () => {
    const first = await ingestMetaComment(comment());
    const second = await ingestMetaComment(
      comment({ commentId: 'post-2_c1', postId: 'post-2', createdAt: LATER }),
    );

    expect(second).toMatchObject({ createdConversation: true, conversationNumber: 2 });
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(await db.select().from(contacts)).toHaveLength(1);
  });

  it('keeps comment threads and direct messages apart for the same person', async () => {
    const onPost = await ingestMetaComment(comment({ from: PSID }));
    const direct = await ingestMetaMessage(dm({ sentAt: LATER }));

    expect(direct).toMatchObject({ createdConversation: true });
    expect(direct.conversationId).not.toBe(onPost.conversationId);
  });

  it('reopens a resolved comment thread, naming who resolved it', async () => {
    const root = await ingestMetaComment(comment());
    const resolver = await resolveAsAgent(root.conversationId);

    await ingestMetaComment(
      comment({ commentId: 'post-1_c2', parentCommentId: 'post-1_c1', createdAt: LATER }),
    );

    expect(await conversation(root.conversationId)).toMatchObject({
      status: 'Open',
      reopenCount: 1,
      resolvedAt: null,
      resolvedByAgentId: resolver,
    });
    expect((await eventsOf(root.conversationId)).filter((e) => e.type === 'reopened')).toEqual([
      {
        type: 'reopened',
        actorLabel: 'inbound_facebook',
        data: { reason: 'customer_replied', resolvedBy: resolver },
      },
    ]);
  });

  it('keys an Instagram comment thread, and labels it, by its own platform', async () => {
    const result = await ingestMetaComment(
      comment({ platform: 'instagram', connection: 'instagram_login' }),
    );

    expect(await conversation(result.conversationId)).toMatchObject({
      channel: 'instagram_comment',
      externalId: 'instagram:comment:post-1_c1',
    });
    expect(
      (await eventsOf(result.conversationId)).filter((e) => e.type === 'comment_thread_opened'),
    ).toEqual([
      {
        type: 'comment_thread_opened',
        actorLabel: 'inbound_instagram',
        data: { postId: 'post-1', rootCommentId: 'post-1_c1' },
      },
    ]);
  });

  // Until an admin adds a comments row, a comment ticket starts where it
  // always did: in the platform row's group, recorded against that row.
  it('starts a comment ticket from its comments row, or from the platform row without one', async () => {
    const [platformGroup, social] = await db
      .insert(groups)
      .values([{ name: 'Platform default' }, { name: 'Social' }])
      .returning({ id: groups.id });
    const [facebookRow] = await db
      .insert(channels)
      .values({ type: 'facebook', name: 'Facebook', config: {}, defaultGroupId: platformGroup!.id })
      .returning({ id: channels.id });

    const before = await ingestMetaComment(comment());
    expect(await conversation(before.conversationId)).toMatchObject({
      channel: 'facebook_comment',
      channelId: facebookRow!.id,
    });
    expect(await groupOf(before.conversationId)).toBe(platformGroup!.id);

    // An inactive comments row routes nothing; an active one wins.
    await db.insert(channels).values({
      type: 'facebook_comment',
      name: 'Old Facebook comments',
      config: {},
      defaultGroupId: platformGroup!.id,
      isActive: false,
    });
    const [commentsRow] = await db
      .insert(channels)
      .values({
        type: 'facebook_comment',
        name: 'Facebook comments',
        config: {},
        defaultGroupId: social!.id,
      })
      .returning({ id: channels.id });

    const after = await ingestMetaComment(
      comment({ commentId: 'post-2_c1', postId: 'post-2', createdAt: LATER }),
    );
    expect(await conversation(after.conversationId)).toMatchObject({
      channel: 'facebook_comment',
      channelId: commentsRow!.id,
    });
    expect(await groupOf(after.conversationId)).toBe(social!.id);

    // A direct message is the platform's, comments row or not.
    const direct = await ingestMetaMessage(dm({ sentAt: LATER }));
    expect(await conversation(direct.conversationId)).toMatchObject({
      channel: 'facebook',
      channelId: facebookRow!.id,
    });
  });

  // Recorded, not endorsed: unlike a direct message, the lookup by
  // external_id does not skip a closed ticket, so a reply lands on it and it
  // stays closed — what email does, and the opposite of a DM.
  it('appends a reply to a closed comment thread and leaves it closed', async () => {
    const root = await ingestMetaComment(comment());
    await setStatus(root.conversationId, 'Closed');

    const reply = await ingestMetaComment(
      comment({ commentId: 'post-1_c2', parentCommentId: 'post-1_c1', createdAt: LATER }),
    );

    expect(reply.conversationId).toBe(root.conversationId);
    expect(await conversation(root.conversationId)).toMatchObject({
      status: 'Closed',
      reopenCount: 0,
    });
  });

  it('files an empty comment with no author under placeholders', async () => {
    const result = await ingestMetaComment(comment({ from: '', fromName: null, text: '' }));

    expect((await conversation(result.conversationId)).subject).toBe('Facebook comment');
    expect(await messagesOf(result.conversationId)).toMatchObject([
      { bodyText: '[empty comment]', fromAddress: null },
    ]);
    expect(
      await db.select({ identifier: contactIdentities.identifier }).from(contactIdentities),
    ).toEqual([{ identifier: 'unknown:post-1_c1' }]);
  });

  it('writes nothing the second time a comment id arrives', async () => {
    const first = await ingestMetaComment(comment());
    const again = await ingestMetaComment(comment());

    expect(again).toEqual({
      conversationId: first.conversationId,
      conversationNumber: 1,
      messageId: first.messageId,
      createdConversation: false,
      duplicate: true,
    });
    expect(await messagesOf(first.conversationId)).toHaveLength(1);
  });
});

/**
 * Deliveries are processed in no order, and a batch with an item that failed is
 * run again whole — so the item that failed is stored after siblings newer
 * than it. Each case stores the newer thing first, then the older one, and
 * expects the ticket to stay where the newer one put it: in the list, in the
 * messaging window, and on the next-response clock.
 */
describe('an older Meta item stored after a newer one', () => {
  const OPENED = new Date('2026-09-20T09:00:00Z');
  const ANSWERED = new Date('2026-09-20T09:30:00Z');
  const OLDER = new Date('2026-09-20T10:00:00Z');
  const NEWER = new Date('2026-09-20T10:05:00Z');
  const HOUR = 3_600_000;

  /** The default policy, so `applySlaOnCreate` gives every new ticket an hour. */
  async function hourlyPolicy() {
    const target = { firstResponseMins: 60, nextResponseMins: 60, resolutionMins: 1440 };
    await db.insert(slaPolicies).values({
      name: 'every hour',
      hoursSource: 'round_the_clock',
      isDefault: true,
      targets: { low: target, medium: target, high: target, urgent: target },
    });
  }

  /** What `storeAgentReply` and `onAgentReply` leave on the ticket, at a chosen instant. */
  async function answered(conversationId: string, at: Date) {
    await db
      .update(conversations)
      .set({
        lastMessageAt: at,
        lastAgentMessageAt: at,
        firstRespondedAt: at,
        nextResponseDueAt: null,
      })
      .where(eq(conversations.id, conversationId));
  }

  /** A DM ticket we have answered, on which the customer wrote again at NEWER. */
  async function answeredTicket() {
    await hourlyPolicy();
    const opened = await ingestMetaMessage(dm({ mid: 'm_opened', sentAt: OPENED }));
    await answered(opened.conversationId, ANSWERED);
    await ingestMetaMessage(dm({ mid: 'm_newer', sentAt: NEWER, text: 'Hello?' }));
    return opened.conversationId;
  }

  async function clocks(conversationId: string) {
    const [row] = await db
      .select({
        lastMessageAt: conversations.lastMessageAt,
        lastCustomerMessageAt: conversations.lastCustomerMessageAt,
        nextResponseDueAt: conversations.nextResponseDueAt,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    return row!;
  }

  const onNewer = {
    lastMessageAt: NEWER,
    lastCustomerMessageAt: NEWER,
    nextResponseDueAt: new Date(NEWER.getTime() + HOUR),
  };

  it('keeps a direct message thread on the newer message', async () => {
    const ticket = await answeredTicket();
    expect(await clocks(ticket)).toEqual(onNewer);

    await ingestMetaMessage(dm({ mid: 'm_older', sentAt: OLDER, text: 'Any news?' }));

    expect((await messagesOf(ticket)).map((m) => m.channelMessageId)).toEqual([
      'm_opened',
      'm_older',
      'm_newer',
    ]);
    // Plainly written, both columns read 10:00 and the clock 11:00.
    expect(await clocks(ticket)).toEqual(onNewer);
  });

  // An agent answered the newer message before the older one was stored —
  // inside a retry's backoff, say. In arrival order that reply answered both,
  // so nothing is owed, and the ticket must not read as awaiting us.
  it('starts no clock for an older message when an agent has answered the newer one', async () => {
    const ticket = await answeredTicket();
    const repliedAt = new Date(NEWER.getTime() + 2 * 60_000);
    await answered(ticket, repliedAt);

    await ingestMetaMessage(dm({ mid: 'm_older', sentAt: OLDER, text: 'Any news?' }));

    expect(await clocks(ticket)).toEqual({
      lastMessageAt: repliedAt,
      lastCustomerMessageAt: NEWER,
      nextResponseDueAt: null,
    });
  });

  it('keeps a comment thread on a reply stored before an older one', async () => {
    await hourlyPolicy();
    const root = await ingestMetaComment(comment({ createdAt: OPENED }));
    await answered(root.conversationId, ANSWERED);
    const reply = (commentId: string, createdAt: Date) =>
      ingestMetaComment(comment({ commentId, parentCommentId: 'post-1_c1', createdAt }));

    await reply('post-1_c3', NEWER);
    const older = await reply('post-1_c2', OLDER);

    expect(older).toMatchObject({
      conversationId: root.conversationId,
      createdConversation: false,
    });
    expect(await clocks(root.conversationId)).toEqual(onNewer);
  });

  it('restarts the clock from the newer message when an older postback lands', async () => {
    const ticket = await answeredTicket();
    const postback: NormalisedInteraction = {
      platform: 'facebook',
      connection: 'facebook_page',
      kind: 'postback',
      from: PSID,
      at: OLDER,
      opensWindow: true,
      summary: 'Track my order',
      payload: 'TRACK',
      standby: false,
    };

    expect(await applyMetaInteraction(postback)).toBe(true);
    // From the postback's own instant, the clock would read 11:00.
    expect(await clocks(ticket)).toEqual(onNewer);
  });
});

// The plan's rollback of Stage 1.2 moves every comment thread back onto
// `facebook`/`instagram`, where a direct message's lookup matches it on the
// channel and only its external id keeps a private message off a public thread
// (`liveConversationFilter`).
describe('Meta ingest, once rolling back 1.2 has moved comments back', () => {
  const { moveCommentsBack } = withoutCommentChannelCheck();

  it('keeps the commenter’s taps and direct messages off the comment thread', async () => {
    const onPost = await ingestMetaComment(comment({ from: PSID }));
    expect(await moveCommentsBack()).toBe(1);

    // A tap with no chat to land on writes nothing, rather than opening the
    // window on the public thread.
    const tap: NormalisedInteraction = {
      platform: 'facebook',
      connection: 'facebook_page',
      kind: 'postback',
      from: PSID,
      at: LATER,
      opensWindow: true,
      summary: 'Track my order',
      payload: 'TRACK',
      standby: false,
    };
    expect(await applyMetaInteraction(tap)).toBe(false);

    const direct = await ingestMetaMessage(dm({ sentAt: LATER }));
    expect(direct).toMatchObject({ createdConversation: true });
    expect(direct.conversationId).not.toBe(onPost.conversationId);
    expect(await messagesOf(onPost.conversationId)).toHaveLength(1);
  });

  it('puts a reply on the moved thread, and leaves it on its platform', async () => {
    const root = await ingestMetaComment(comment());
    expect(await moveCommentsBack()).toBe(1);

    const reply = await ingestMetaComment(
      comment({ commentId: 'post-1_c2', parentCommentId: 'post-1_c1', createdAt: LATER }),
    );

    expect(reply).toMatchObject({
      conversationId: root.conversationId,
      createdConversation: false,
    });
    expect(await conversation(root.conversationId)).toMatchObject({ channel: 'facebook' });
  });
});
