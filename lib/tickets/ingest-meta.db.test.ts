import { asc, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  aiCategoryRuns,
  aiPriorityRuns,
  channels,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  jobs,
  messages,
  routingDecisions,
  slaPolicies,
  ticketCategories,
  ticketStatuses,
} from '@/db/schema';
import { classifyMessageCategory } from '@/lib/category-ai/run';
import { forgetCategoryAiSettings } from '@/lib/category-ai/settings';
import { resetEnvCache } from '@/lib/env';
import { classifyMessagePriority } from '@/lib/priority-ai/run';
import { settleRouting } from '@/lib/routing/apply';
import { handToRouteGroup } from '@/lib/routing/hand-to';
import { stubFetch } from '@/lib/testing/fetch';
import type {
  NormalisedComment,
  NormalisedDirectMessage,
  NormalisedInteraction,
} from '@/lib/meta/types';
import { subcategoriseFromMessage } from '@/lib/subcategorise/apply';
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

  /*
   * Deliveries are processed in no order, and a batch with an item that failed
   * is run again whole, so a passer-by's reply under the customer's comment
   * can be stored before the comment itself. The reply opens the ticket under
   * its author; the comment, when it arrives, hands it to the customer.
   */
  describe('a thread whose first comment arrives after a reply to it', () => {
    const BOB = '9988776655';
    const bobsReply = (overrides: Partial<NormalisedComment> = {}) =>
      comment({
        commentId: 'post-1_c2',
        parentCommentId: 'post-1_c1',
        from: BOB,
        fromName: 'Bob',
        text: 'Same here, nobody answers',
        createdAt: LATER,
        ...overrides,
      });

    async function contactOf(identifier: string) {
      const [row] = await db
        .select({ id: contactIdentities.contactId })
        .from(contactIdentities)
        .where(eq(contactIdentities.identifier, identifier));
      return row!.id;
    }

    async function requesterKindOf(conversationId: string) {
      const [row] = await db
        .select({ kind: conversations.requesterKind })
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      return row!.kind;
    }

    function requesterEvents(conversationId: string) {
      return eventsOf(conversationId).then((events) =>
        events.filter((event) => event.type === 'requester_changed'),
      );
    }

    /**
     * Bob a merchant and Amira with a parcel coming, both on record before Bob
     * replies under her comment, so the three things the kind can be after the
     * move — his, nobody's, hers — are three different values.
     */
    async function bothOnRecord() {
      await ingestMetaComment(comment({ commentId: 'post-9_c1', postId: 'post-9', from: BOB }));
      await ingestMetaComment(comment({ commentId: 'post-8_c1', postId: 'post-8' }));
      await db
        .update(contacts)
        .set({ isShipper: true })
        .where(eq(contacts.id, await contactOf(BOB)));
      await db
        .update(contacts)
        .set({ isRecipient: true })
        .where(eq(contacts.id, await contactOf('1122334455')));
    }

    it('makes the first comment’s author the requester when it arrives', async () => {
      const opened = await ingestMetaComment(bobsReply());
      const bob = await contactOf(BOB);
      expect(await conversation(opened.conversationId)).toMatchObject({
        requesterContactId: bob,
        subject: 'Same here, nobody answers',
      });

      const root = await ingestMetaComment(comment());
      const amira = await contactOf('1122334455');

      expect(root).toMatchObject({
        conversationId: opened.conversationId,
        createdConversation: false,
      });
      // The subject is hers too: it was the opening comment's first line, Bob's.
      expect(await conversation(opened.conversationId)).toMatchObject({
        requesterContactId: amira,
        subject: 'My parcel never came',
      });
      expect(await requesterEvents(opened.conversationId)).toEqual([
        {
          type: 'requester_changed',
          actorLabel: 'inbound_facebook',
          data: { reason: 'thread_root', from: bob, to: amira, rootCommentId: 'post-1_c1' },
        },
      ]);
      expect(await messagesOf(opened.conversationId)).toHaveLength(2);

      // Meta delivers the first comment again: it is a duplicate, and moves nothing.
      expect(await ingestMetaComment(comment())).toMatchObject({ duplicate: true });
      expect(await requesterEvents(opened.conversationId)).toHaveLength(1);
    });

    it('leaves it alone when the first comment came first', async () => {
      // A reply never takes the ticket from the comment it answers.
      const opened = await ingestMetaComment(comment());
      await ingestMetaComment(bobsReply());

      expect((await conversation(opened.conversationId)).requesterContactId).toBe(
        await contactOf('1122334455'),
      );
      expect(await requesterEvents(opened.conversationId)).toEqual([]);
    });

    it('leaves it alone when the reply that came first was the requester’s own', async () => {
      const opened = await ingestMetaComment(
        comment({
          commentId: 'post-1_c2',
          parentCommentId: 'post-1_c1',
          text: 'Any update?',
          createdAt: LATER,
        }),
      );
      await ingestMetaComment(comment());

      expect(await conversation(opened.conversationId)).toMatchObject({
        requesterContactId: await contactOf('1122334455'),
        subject: 'Any update?',
      });
      expect(await requesterEvents(opened.conversationId)).toEqual([]);
    });

    it('reads the kind afresh off the first comment’s author', async () => {
      await bothOnRecord();
      const opened = await ingestMetaComment(bobsReply());
      expect(await requesterKindOf(opened.conversationId)).toBe('merchant');

      await ingestMetaComment(comment());
      expect(await requesterKindOf(opened.conversationId)).toBe('recipient');
    });

    // A photo or a sticker gives the subcategoriser no words, but the kind is
    // read off records, so it is read all the same.
    it('reads it when the first comment has no words, too', async () => {
      await bothOnRecord();
      const opened = await ingestMetaComment(bobsReply());

      await ingestMetaComment(comment({ text: '' }));
      expect(await requesterKindOf(opened.conversationId)).toBe('recipient');
    });

    // Bob's own run reads the ticket while he holds it, and comes to write his
    // kind only after the root has moved it to Amira.
    it('keeps the replier’s run from writing his kind back over the move', async () => {
      await bothOnRecord();
      const amira = await contactOf('1122334455');
      const opened = await ingestMetaComment(bobsReply());
      // As Bob's ingest left the ticket, before his run read his record.
      await db
        .update(conversations)
        .set({ requesterKind: null })
        .where(eq(conversations.id, opened.conversationId));

      let raced: Promise<unknown> | undefined;
      await db.transaction(async (tx) => {
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, opened.conversationId))
          .for('update');
        raced = subcategoriseFromMessage(
          {
            conversationId: opened.conversationId,
            messageId: opened.messageId,
            bodyText: 'Same here, nobody answers',
            kind: 'reply',
            direction: 'inbound',
          },
          'silent',
        );
        await untilSomebodyWaits();
        // What `adoptRootAuthor` writes.
        await tx
          .update(conversations)
          .set({ requesterContactId: amira, requesterKind: null })
          .where(eq(conversations.id, opened.conversationId));
      });
      await raced;

      expect(await requesterKindOf(opened.conversationId)).toBeNull();
    });

    // Amira's own reply opened the ticket, and an agent is merging her into
    // another record as her comment arrives. Waiting the merge out and moving
    // the ticket then would hand it back to the contact merged away.
    it('leaves the ticket where a merge of the first comment’s author puts it', async () => {
      const opened = await ingestMetaComment(
        comment({
          commentId: 'post-1_c2',
          parentCommentId: 'post-1_c1',
          text: 'Any update?',
          createdAt: LATER,
        }),
      );
      const amira = await contactOf('1122334455');
      await ingestMetaComment(
        comment({ commentId: 'post-6_c1', postId: 'post-6', from: '7766554433' }),
      );
      const survivor = await contactOf('7766554433');

      let raced: Promise<unknown> | undefined;
      await db.transaction(async (tx) => {
        // `mergeContacts`, in its order: both contacts, then their tickets.
        await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(inArray(contacts.id, [amira, survivor]))
          .for('update');
        await tx
          .update(conversations)
          .set({ requesterContactId: survivor })
          .where(eq(conversations.requesterContactId, amira));
        raced = ingestMetaComment(comment());
        await untilSomebodyWaits();
      });
      await raced;

      expect((await conversation(opened.conversationId)).requesterContactId).toBe(survivor);
      expect(await requesterEvents(opened.conversationId)).toEqual([]);
    });

    // A contact merge re-points the ticket between the root's lookup and its
    // transaction. The move is decided on the row as the merge left it, and the
    // event names who it actually replaced.
    it('names the requester it replaced, not the one it was looked up with', async () => {
      const CAROL = '5544332211';
      const opened = await ingestMetaComment(bobsReply());
      const bob = await contactOf(BOB);
      await ingestMetaComment(comment({ commentId: 'post-7_c1', postId: 'post-7', from: CAROL }));
      const carol = await contactOf(CAROL);

      let raced: Promise<unknown> | undefined;
      await db.transaction(async (tx) => {
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, opened.conversationId))
          .for('update');
        // What merging Bob into Carol does to the tickets he requested.
        await tx
          .update(conversations)
          .set({ requesterContactId: carol })
          .where(eq(conversations.requesterContactId, bob));
        raced = ingestMetaComment(comment());
        await untilSomebodyWaits();
      });
      await raced;

      expect(await requesterEvents(opened.conversationId)).toEqual([
        {
          type: 'requester_changed',
          actorLabel: 'inbound_facebook',
          data: {
            reason: 'thread_root',
            from: carol,
            to: await contactOf('1122334455'),
            rootCommentId: 'post-1_c1',
          },
        },
      ]);
    });
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

/** Resolves once another session is waiting on a lock this test holds. */
async function untilSomebodyWaits(): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    const [row] = await db.execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (row && row.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('nothing came to wait on the lock this test holds');
}

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

/**
 * The thread a passer-by's reply opened, driven through the real ingest, both
 * of Jev's classifiers (TypeSafe answered by the test) and the router, on a
 * Facebook Page routing by category — the state the Page and Instagram rows
 * are about to be switched to. Each classifier and the router has its own
 * tests of the rule it follows; these are the three together, in the order
 * production would run them: the reply stored and judged, then the root.
 */
describe('a reply-first comment thread, through Jev and the router', () => {
  const BOB = '9988776655';
  const BASE = 'https://typesafe.test';

  beforeEach(async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    vi.stubEnv('PRIORITY_AI', 'apply');
    resetEnvCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.execute(sql`
      insert into category_ai_settings (id, mode, min_probability, routing_window_minutes)
      values (1, 'apply', 0.6, 5)
      on conflict (id) do update set mode = 'apply', min_probability = 0.6`);
    forgetCategoryAiSettings();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetEnvCache();
    forgetCategoryAiSettings();
  });

  /** Customer Care on the Page's row, and the two teams its categories route to. */
  async function page() {
    const team = async (name: string, agentName: string, email: string) => {
      const [agent] = await db
        .insert(agents)
        .values({ name: agentName, email, presence: 'online', lastSeenAt: new Date() })
        .returning({ id: agents.id });
      const [group] = await db
        .insert(groups)
        .values({ name, assignmentStrategy: 'round_robin', assignWithinHoursOnly: false })
        .returning({ id: groups.id });
      await db.insert(groupMembers).values({ groupId: group!.id, agentId: agent!.id });
      return { agent: agent!.id, group: group!.id };
    };
    const care = await team('Customer Care', 'Hana', 'hana@shipblu.test');
    const sales = await team('Sales', 'Samir', 'samir@shipblu.test');
    const merchants = await team('Merchant Care', 'Mona', 'mona@shipblu.test');
    for (const [key, group] of [
      ['sales', sales.group],
      ['merchant_support', merchants.group],
    ] as const) {
      await db
        .update(ticketCategories)
        .set({ routeGroupId: group })
        .where(eq(ticketCategories.key, key));
    }
    await db.insert(channels).values({
      type: 'facebook',
      name: 'Facebook Page',
      config: {},
      defaultGroupId: care.group,
      routingMode: 'category',
    });
    return { care, sales, merchants };
  }

  /** Jev answering both questions at once; each classifier reads its own. */
  function jev(category: string, priority: string, probability = 0.9) {
    return stubFetch(() =>
      Response.json({
        model: 'jev-1.13.0',
        answers: {
          ticket_category: {
            type: 'choice',
            choice: category,
            probabilities: { [category]: probability },
            confidence: 0.8,
          },
          priority: {
            type: 'choice',
            choice: priority,
            probabilities: { [priority]: probability },
            confidence: 0.8,
          },
        },
        usage: { input_tokens: 400 },
      }),
    );
  }

  /** Both classifiers on one message, as the two jobs it queued would. */
  async function judged(messageId: string) {
    return {
      priority: await classifyMessagePriority(messageId, { baseUrl: BASE }),
      category: await classifyMessageCategory(messageId, { baseUrl: BASE }),
    };
  }

  async function ticketOf(conversationId: string) {
    const [row] = await db
      .select({
        requesterContactId: conversations.requesterContactId,
        priority: conversations.priority,
        groupId: conversations.groupId,
        assigneeAgentId: conversations.assigneeAgentId,
        categoryKey: ticketCategories.key,
      })
      .from(conversations)
      .leftJoin(ticketCategories, eq(ticketCategories.id, conversations.categoryId))
      .where(eq(conversations.id, conversationId));
    return row!;
  }

  async function routing(conversationId: string) {
    const [row] = await db
      .select({ stage: routingDecisions.stage, outcome: routingDecisions.outcome })
      .from(routingDecisions)
      .where(eq(routingDecisions.conversationId, conversationId));
    return row!;
  }

  async function contactOf(identifier: string) {
    const [row] = await db
      .select({ id: contactIdentities.contactId })
      .from(contactIdentities)
      .where(eq(contactIdentities.identifier, identifier));
    return row!.id;
  }

  /** Bob's "scammers" reply, stored before Amira's comment, judged urgent and sales. */
  async function bobFirst() {
    const opened = await ingestMetaComment(
      comment({
        commentId: 'post-1_c2',
        parentCommentId: 'post-1_c1',
        from: BOB,
        fromName: 'Bob',
        text: 'Scammers, I will sue. How much to ship to Alexandria?',
        createdAt: LATER,
      }),
    );
    expect(opened).toMatchObject({ createdConversation: true });
    jev('sales', 'urgent');
    expect(await judged(opened.messageId)).toMatchObject({
      priority: { outcome: 'applied' },
      category: { outcome: 'applied' },
    });
    // Held still: the root may yet arrive and take the ticket.
    expect(await routing(opened.conversationId)).toMatchObject({
      stage: 'holding',
      outcome: null,
    });
    expect(await ticketOf(opened.conversationId)).toMatchObject({
      priority: 'urgent',
      categoryKey: 'sales',
      assigneeAgentId: null,
    });
    return opened;
  }

  it('files, prices and routes the ticket on the customer’s own comment', async () => {
    const t = await page();
    const opened = await bobFirst();

    const root = await ingestMetaComment(comment({ text: 'My shop’s COD payments never arrived' }));
    expect(root.conversationId).toBe(opened.conversationId);
    jev('merchant_support', 'low');
    expect(await judged(root.messageId)).toMatchObject({
      priority: { outcome: 'applied' },
      category: { outcome: 'applied' },
    });

    expect(await ticketOf(opened.conversationId)).toMatchObject({
      requesterContactId: await contactOf('1122334455'),
      priority: 'low',
      categoryKey: 'merchant_support',
      groupId: t.merchants.group,
      assigneeAgentId: t.merchants.agent,
    });
    expect(await routing(opened.conversationId)).toMatchObject({
      stage: 'decided',
      outcome: 'category',
    });

    // Bob's next comment is somebody under the customer's: neither asks.
    const later = await ingestMetaComment(
      comment({
        commentId: 'post-1_c3',
        parentCommentId: 'post-1_c1',
        from: BOB,
        fromName: 'Bob',
        text: 'Still waiting, this is urgent',
        createdAt: new Date(LATER.getTime() + 60_000),
      }),
    );
    expect(await judged(later.messageId)).toEqual({
      priority: { status: 'skipped', reason: 'not written by the requester' },
      category: { status: 'skipped', reason: 'not written by the requester' },
    });
  });

  // Her answer agrees with what Bob's reply was read as, and so writes nothing:
  // its run is what makes the category hers, and routes the ticket.
  it('routes at once on the customer’s comment answered as Bob’s reply was', async () => {
    const t = await page();
    const opened = await bobFirst();

    const root = await ingestMetaComment(comment({ text: 'How much to ship 30 parcels a week?' }));
    jev('sales', 'medium');
    expect(await judged(root.messageId)).toMatchObject({ category: { outcome: 'applied' } });

    expect(await routing(opened.conversationId)).toMatchObject({
      stage: 'decided',
      outcome: 'category',
    });
    expect(await ticketOf(opened.conversationId)).toMatchObject({
      categoryKey: 'sales',
      groupId: t.sales.group,
      assigneeAgentId: t.sales.agent,
    });
  });

  // Meta omitted the root's created_time, so parse.ts stamped it when it was
  // read: after Bob's reply, which is then the thread's earliest message.
  it('does the same when the customer’s comment is stamped after Bob’s reply', async () => {
    const t = await page();
    const opened = await bobFirst();

    const root = await ingestMetaComment(
      comment({
        text: 'My shop’s COD payments never arrived',
        createdAt: new Date(LATER.getTime() + 5 * 60_000),
      }),
    );
    jev('merchant_support', 'low');
    expect(await judged(root.messageId)).toMatchObject({
      priority: { outcome: 'applied' },
      category: { outcome: 'applied' },
    });

    expect(await ticketOf(opened.conversationId)).toMatchObject({
      priority: 'low',
      categoryKey: 'merchant_support',
      groupId: t.merchants.group,
      assigneeAgentId: t.merchants.agent,
    });
  });

  it('routes on nothing of Bob’s when the customer’s comment has no words', async () => {
    const t = await page();
    const opened = await bobFirst();

    // A photo: nothing to ask either classifier about.
    const root = await ingestMetaComment(comment({ text: '' }));
    const calls = jev('merchant_support', 'low');
    expect(await judged(root.messageId)).toEqual({
      priority: { status: 'skipped', reason: 'no text' },
      category: { status: 'skipped', reason: 'no text' },
    });
    expect(calls).not.toHaveBeenCalled();

    expect(await settleRouting(opened.conversationId)).toBe('decided');

    expect(await routing(opened.conversationId)).toMatchObject({ outcome: 'fallback' });
    expect(await ticketOf(opened.conversationId)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
      // Labels only: a person or her own next words replace them. The
      // priority stands because her photo was her opening, and later words
      // may raise and never lower.
      categoryKey: 'sales',
      priority: 'urgent',
    });
  });

  // Set aside at the window's end, with no policy for it; her own words then
  // read as his were, which writes nothing, and the category is hers now, so
  // the policy keyed on it is chosen as a write's would have been.
  it('gives the policy to the category her later words agree with, once it was set aside', async () => {
    await page();
    const round = { firstResponseMins: 30, nextResponseMins: 30, resolutionMins: 240 };
    const [sales] = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, 'sales'));
    const [salesPolicy] = await db
      .insert(slaPolicies)
      .values({
        name: 'Sales',
        hoursSource: 'round_the_clock',
        targets: { low: round, medium: round, high: round, urgent: round },
        conditions: { field: 'category.id', op: 'eq', value: sales!.id },
      })
      .returning({ id: slaPolicies.id });
    const opened = await bobFirst();
    await ingestMetaComment(comment({ text: '' }));
    expect(await settleRouting(opened.conversationId)).toBe('decided');
    const policyOf = async () => {
      const [row] = await db
        .select({ slaPolicyId: conversations.slaPolicyId })
        .from(conversations)
        .where(eq(conversations.id, opened.conversationId));
      return row!.slaPolicyId;
    };
    expect(await policyOf()).toBeNull();

    const hers = await ingestMetaComment(
      comment({
        commentId: 'post-1_c3',
        parentCommentId: 'post-1_c1',
        text: 'How much to ship 30 parcels a week?',
        createdAt: new Date(LATER.getTime() + 60_000),
      }),
    );
    jev('sales', 'medium');
    expect(await judged(hers.messageId)).toMatchObject({ category: { outcome: 'applied' } });

    expect(await policyOf()).toBe(salesPolicy!.id);
  });

  /** A policy for every priority, under `conditions`, at `position`. */
  async function policy(name: string, conditions: unknown, position: number) {
    const round = { firstResponseMins: 30, nextResponseMins: 30, resolutionMins: 240 };
    const [row] = await db
      .insert(slaPolicies)
      .values({
        name,
        hoursSource: 'round_the_clock',
        targets: { low: round, medium: round, high: round, urgent: round },
        conditions,
        position,
      })
      .returning({ id: slaPolicies.id });
    return row!.id;
  }

  async function categoryNamed(key: string) {
    const [row] = await db
      .select({ id: ticketCategories.id })
      .from(ticketCategories)
      .where(eq(ticketCategories.key, key));
    return row!.id;
  }

  async function policyOn(conversationId: string) {
    const [row] = await db
      .select({ slaPolicyId: conversations.slaPolicyId })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    return row!.slaPolicyId;
  }

  // The Page not routing: Bob's reply was filed and its write chose the Sales
  // policy. Her comment, read the same, lowers the priority as her opening
  // and writes no category: a second look then would take up the lowered
  // priority as though the category had changed, and move the ticket's
  // clocks off the policy its category chose.
  it('gives a category that already had its look no second one when her comment agrees', async () => {
    await page();
    await db.update(channels).set({ routingMode: 'default_group' });
    await policy('Low priority', { field: 'priority', op: 'eq', value: 'low' }, 0);
    const salesPolicy = await policy(
      'Sales',
      { field: 'category.id', op: 'eq', value: await categoryNamed('sales') },
      1,
    );
    const opened = await ingestMetaComment(
      comment({
        commentId: 'post-1_c2',
        parentCommentId: 'post-1_c1',
        from: BOB,
        fromName: 'Bob',
        text: 'How much to ship to Alexandria?',
        createdAt: LATER,
      }),
    );
    jev('sales', 'urgent');
    await judged(opened.messageId);
    expect(await policyOn(opened.conversationId)).toBe(salesPolicy);

    const root = await ingestMetaComment(comment({ text: 'How much to ship 30 parcels a week?' }));
    jev('sales', 'low');
    expect(await judged(root.messageId)).toMatchObject({
      priority: { outcome: 'applied' },
      category: { outcome: 'applied' },
    });

    expect(await ticketOf(opened.conversationId)).toMatchObject({ priority: 'low' });
    expect(await policyOn(opened.conversationId)).toBe(salesPolicy);
  });

  // No root came in the window, so its end routed on Bob's reading as the
  // customer's and chose the Sales policy. Her comment then lowers the
  // priority as her opening and agrees on the category: no second look,
  // which would take the lowered priority up as though the category had
  // changed.
  it('gives a category the window’s end routed on no second look when her comment agrees', async () => {
    await page();
    await policy('Low priority', { field: 'priority', op: 'eq', value: 'low' }, 0);
    const salesPolicy = await policy(
      'Sales',
      { field: 'category.id', op: 'eq', value: await categoryNamed('sales') },
      1,
    );
    const opened = await bobFirst();
    expect(await settleRouting(opened.conversationId)).toBe('decided');
    expect(await routing(opened.conversationId)).toMatchObject({ outcome: 'category' });
    expect(await policyOn(opened.conversationId)).toBe(salesPolicy);

    const root = await ingestMetaComment(comment({ text: 'How much to ship 30 parcels a week?' }));
    jev('sales', 'low');
    expect(await judged(root.messageId)).toMatchObject({
      priority: { outcome: 'applied' },
      category: { outcome: 'applied' },
    });

    expect(await ticketOf(opened.conversationId)).toMatchObject({ priority: 'low' });
    expect(await policyOn(opened.conversationId)).toBe(salesPolicy);
  });

  // Set aside, then handed to Sales: the move chose the Sales policy with the
  // category on the ticket. Her answer raising the priority and agreeing on
  // the category is no second look, which would take the raise up as though
  // the category had changed.
  it('gives a set-aside category no look once a move has chosen its policy', async () => {
    const t = await page();
    await policy('Urgent', { field: 'priority', op: 'eq', value: 'urgent' }, 0);
    const salesPolicy = await policy(
      'Sales',
      { field: 'category.id', op: 'eq', value: await categoryNamed('sales') },
      1,
    );
    const opened = await ingestMetaComment(
      comment({
        commentId: 'post-1_c2',
        parentCommentId: 'post-1_c1',
        from: BOB,
        fromName: 'Bob',
        text: 'How much to ship to Alexandria?',
        createdAt: LATER,
      }),
    );
    jev('sales', 'high');
    await judged(opened.messageId);
    await ingestMetaComment(comment({ text: '' }));
    expect(await settleRouting(opened.conversationId)).toBe('decided');
    expect(await ticketOf(opened.conversationId)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
    });
    const handed = await handToRouteGroup(
      opened.conversationId,
      { agentId: t.care.agent },
      { expectedGroupId: t.sales.group, expectedAssigneeId: t.care.agent },
    );
    expect(handed).toMatchObject({ ok: true });
    expect(await policyOn(opened.conversationId)).toBe(salesPolicy);

    const hers = await ingestMetaComment(
      comment({
        commentId: 'post-1_c3',
        parentCommentId: 'post-1_c1',
        text: 'Please, today: 30 parcels are waiting',
        createdAt: new Date(LATER.getTime() + 60_000),
      }),
    );
    jev('sales', 'urgent');
    expect(await judged(hers.messageId)).toMatchObject({
      priority: { outcome: 'applied' },
      category: { outcome: 'applied' },
    });
    expect(await ticketOf(opened.conversationId)).toMatchObject({ priority: 'urgent' });
    expect(await policyOn(opened.conversationId)).toBe(salesPolicy);
  });

  // Two of her comments read as sales, judged out of order: the later one's
  // answer gave the look, which found no policy, and the earlier one,
  // answered late, is answered again — no second look for it, which would
  // take up the priority it raised.
  it('gives a set-aside category its look on her first answer only, whichever is judged first', async () => {
    await page();
    await policy('Urgent', { field: 'priority', op: 'eq', value: 'urgent' }, 0);
    const opened = await ingestMetaComment(
      comment({
        commentId: 'post-1_c2',
        parentCommentId: 'post-1_c1',
        from: BOB,
        fromName: 'Bob',
        text: 'How much to ship to Alexandria?',
        createdAt: LATER,
      }),
    );
    jev('sales', 'high');
    await judged(opened.messageId);
    await ingestMetaComment(comment({ text: '' }));
    expect(await settleRouting(opened.conversationId)).toBe('decided');

    const earlier = await ingestMetaComment(
      comment({
        commentId: 'post-1_c3',
        parentCommentId: 'post-1_c1',
        text: 'Please, today: 30 parcels are waiting',
        createdAt: new Date(LATER.getTime() + 60_000),
      }),
    );
    const later = await ingestMetaComment(
      comment({
        commentId: 'post-1_c4',
        parentCommentId: 'post-1_c1',
        text: 'How much to ship 30 parcels a week?',
        createdAt: new Date(LATER.getTime() + 120_000),
      }),
    );
    jev('sales', 'medium');
    expect(await judged(later.messageId)).toMatchObject({ category: { outcome: 'applied' } });
    expect(await policyOn(opened.conversationId)).toBeNull();

    jev('sales', 'urgent');
    expect(await judged(earlier.messageId)).toMatchObject({
      priority: { outcome: 'applied' },
      category: { outcome: 'applied' },
    });
    expect(await ticketOf(opened.conversationId)).toMatchObject({ priority: 'urgent' });
    expect(await policyOn(opened.conversationId)).toBeNull();
  });

  it('routes on nothing of Bob’s when the answers about the customer’s comment are unsure', async () => {
    const t = await page();
    const opened = await bobFirst();

    const root = await ingestMetaComment(comment({ text: 'Hello?' }));
    jev('merchant_support', 'low', 0.4);
    expect(await judged(root.messageId)).toMatchObject({
      priority: { outcome: 'below_threshold' },
      category: { outcome: 'below_threshold' },
    });

    expect(await settleRouting(opened.conversationId)).toBe('decided');

    expect(await routing(opened.conversationId)).toMatchObject({ outcome: 'fallback' });
    expect(await ticketOf(opened.conversationId)).toMatchObject({
      groupId: t.care.group,
      assigneeAgentId: t.care.agent,
      categoryKey: 'sales',
      priority: 'urgent',
    });
    expect(
      await db
        .select({ outcome: aiPriorityRuns.outcome })
        .from(aiPriorityRuns)
        .where(eq(aiPriorityRuns.messageId, root.messageId)),
    ).toEqual([{ outcome: 'below_threshold' }]);
    expect(
      await db
        .select({ outcome: aiCategoryRuns.outcome })
        .from(aiCategoryRuns)
        .where(eq(aiCategoryRuns.messageId, root.messageId)),
    ).toEqual([{ outcome: 'below_threshold' }]);
  });
});
