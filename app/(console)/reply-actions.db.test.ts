import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which comment an agent's reply on a comment ticket answers, from the action
 * that names it to the job that sends it, against real Postgres with Graph
 * stood in for.
 *
 * The thread every test builds is the one the bug lived in: the requester's
 * comment, the requester's own follow-up, and a passer-by's reply under them
 * filed on the same ticket and newer than both. A private reply goes to
 * whoever wrote the comment it names, so naming the newest would hand the
 * passer-by what the agent wrote for the customer, and spend the one private
 * reply Meta allows on a comment the customer never wrote.
 */

const signedIn = vi.hoisted(() => ({ id: '' }));
const graph = vi.hoisted(() => ({ privateReplyToComment: vi.fn(), replyToComment: vi.fn() }));

vi.mock('@/lib/auth/guard', () => ({
  requireAgent: async () => ({ id: signedIn.id, role: 'admin', permissions: {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/meta/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meta/client')>()),
  privateReplyToComment: graph.privateReplyToComment,
  replyToComment: graph.replyToComment,
}));
// Which host and token: the environment's, and nothing this test is about.
vi.mock('@/lib/meta/connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meta/connection')>()),
  metaConnection: () => 'facebook_page',
}));

const { db } = await import('@/db/client');
const { agents, contacts, conversations, jobs, messages, ticketStatuses } =
  await import('@/db/schema');
const { withCleanDatabase } = await import('@/lib/testing/db');
const { COMMENT_ANSWERED, COMMENT_DELETED, NO_REQUESTER_COMMENT } =
  await import('@/lib/tickets/reply-comment');
const { sendMeta } = await import('@/worker/handlers/send-meta');
const { moderateComment } = await import('./meta-actions');
const { sendReply } = await import('./reply-actions');

withCleanDatabase();

beforeEach(() => {
  graph.privateReplyToComment.mockReset().mockResolvedValue('mid.private');
  graph.replyToComment.mockReset().mockResolvedValue('reply-1');
});

const ROOT = 'post-1_c1';

async function contact(name: string) {
  const [row] = await db.insert(contacts).values({ name }).returning({ id: contacts.id });
  return row!.id;
}

async function commentTicket(requester: string, root = ROOT) {
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'facebook_comment',
      externalId: `facebook:comment:${root}`,
      statusId: open!.id,
      requesterContactId: requester,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

/** A comment as `ingestMetaComment` stores it: its own instant, and its id twice. */
async function comment(conversationId: string, author: string, commentId: string, at: string) {
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: author,
      bodyText: `Comment ${commentId}`,
      channelMessageId: commentId,
      deliveryStatus: 'delivered',
      meta: { metaKind: 'comment', platform: 'facebook', commentId, isPublic: true },
      createdAt: new Date(at),
    })
    .returning({ id: messages.id });
  return row!.id;
}

/**
 * Amira's comment, her follow-up under it, and Bob's reply under both — the
 * newest comment on her ticket, and not hers.
 */
async function threadWithPasserBy() {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test', role: 'admin' })
    .returning({ id: agents.id });
  signedIn.id = agent!.id;

  const amira = await contact('Amira');
  const bob = await contact('Bob');
  const ticket = await commentTicket(amira);
  const root = await comment(ticket, amira, ROOT, '2026-10-20T09:00:00Z');
  const followUp = await comment(ticket, amira, 'post-1_c2', '2026-10-20T09:05:00Z');
  const passerBy = await comment(ticket, bob, 'post-1_c3', '2026-10-20T09:10:00Z');
  return { ticket, amira, bob, root, followUp, passerBy };
}

/** A comment as `moderate_meta_comment` leaves it once Graph confirmed the delete. */
async function deleteFromPost(messageId: string, commentId: string) {
  await db
    .update(messages)
    .set({
      meta: {
        metaKind: 'comment',
        platform: 'facebook',
        commentId,
        isPublic: true,
        moderation: { hidden: false, deleted: true, pending: null, error: null },
      },
    })
    .where(eq(messages.id, messageId));
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function reply(ticket: string, extra: Record<string, string> = {}) {
  return sendReply(
    { error: null },
    form({ conversationId: ticket, body: 'Your order 4411 leaves the hub today.', ...extra }),
  );
}

/** The agent's replies on the ticket, as stored. */
async function replies(ticket: string) {
  return db
    .select({ id: messages.id, meta: messages.meta, status: messages.deliveryStatus })
    .from(messages)
    .where(and(eq(messages.conversationId, ticket), eq(messages.direction, 'outbound')));
}

async function queuedSends() {
  return db.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, 'send_meta'));
}

function job(messageId: string) {
  return {
    id: 'job-1',
    type: 'send_meta',
    payload: { messageId },
    attempts: 1,
    maxAttempts: 5,
  } as never;
}

/** The comment each Graph call was addressed to. */
function addressed(mock: typeof graph.privateReplyToComment) {
  return mock.mock.calls.map(([input]) => (input as { commentId: string }).commentId);
}

describe('a private reply on a comment ticket', () => {
  it('answers the requester’s newest comment, not the passer-by’s newer one', async () => {
    const { ticket } = await threadWithPasserBy();

    const state = await reply(ticket, { metaSendKind: 'private_reply' });
    expect(state.error).toBeNull();

    const [stored] = await replies(ticket);
    expect(stored!.meta).toMatchObject({
      sendKind: 'private_reply',
      isPublic: false,
      commentId: 'post-1_c2',
    });

    await sendMeta(job(stored!.id));

    expect(addressed(graph.privateReplyToComment)).toEqual(['post-1_c2']);
    expect((await replies(ticket))[0]!.status).toBe('sent');
  });

  it('answers the requester’s comment the agent picked', async () => {
    const { ticket, root } = await threadWithPasserBy();

    const state = await reply(ticket, { metaSendKind: 'private_reply', replyToMessageId: root });
    expect(state.error).toBeNull();

    const [stored] = await replies(ticket);
    expect(stored!.meta).toMatchObject({ commentId: ROOT });

    await sendMeta(job(stored!.id));
    expect(addressed(graph.privateReplyToComment)).toEqual([ROOT]);
  });

  it('refuses the passer-by’s comment picked by hand, and writes nothing', async () => {
    const { ticket, passerBy } = await threadWithPasserBy();

    const state = await reply(ticket, {
      metaSendKind: 'private_reply',
      replyToMessageId: passerBy,
    });

    expect(state.error).toMatch(/not one this ticket’s customer wrote/);
    expect(await replies(ticket)).toEqual([]);
    expect(await queuedSends()).toEqual([]);
  });

  // The author alone would let this through: Amira wrote it, on another post.
  it('refuses the requester’s own comment on another ticket', async () => {
    const { ticket, amira } = await threadWithPasserBy();
    const elsewhere = await commentTicket(amira, 'post-2_c1');
    const theirs = await comment(elsewhere, amira, 'post-2_c1', '2026-10-20T09:20:00Z');

    const state = await reply(ticket, { metaSendKind: 'private_reply', replyToMessageId: theirs });

    expect(state.error).toMatch(/not one this ticket’s customer wrote/);
    expect(await replies(ticket)).toEqual([]);
  });

  it('refuses an id that is not one, rather than answering the newest', async () => {
    const { ticket } = await threadWithPasserBy();

    const state = await reply(ticket, {
      metaSendKind: 'private_reply',
      replyToMessageId: 'post-1_c3',
    });

    expect(state.error).toMatch(/not one this ticket’s customer wrote/);
    expect(await replies(ticket)).toEqual([]);
  });

  // Named when the agent wrote, so the requester commenting again before the
  // job runs does not move the reply onto a comment the agent never read.
  it('is sent to the comment it named, however the thread moves before the job runs', async () => {
    const { ticket, amira } = await threadWithPasserBy();

    await reply(ticket, { metaSendKind: 'private_reply' });
    await comment(ticket, amira, 'post-1_c4', '2026-10-20T09:20:00Z');

    const [stored] = await replies(ticket);
    await sendMeta(job(stored!.id));
    expect(addressed(graph.privateReplyToComment)).toEqual(['post-1_c2']);
  });

  // The reply now carries the comment it answers on `meta.commentId`, beside
  // `metaKind: 'comment'` — which is how the moderation controls recognise a
  // comment. A request naming the reply must not act on the customer's comment.
  it('cannot be moderated as the customer’s comment it names', async () => {
    const { ticket } = await threadWithPasserBy();
    await reply(ticket, { metaSendKind: 'private_reply' });
    const [stored] = await replies(ticket);

    const state = await moderateComment(
      { error: null },
      form({ messageId: stored!.id, action: 'delete' }),
    );

    expect(state.error).toBe('That message is not a Facebook or Instagram comment');
    expect(
      await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, 'moderate_meta_comment')),
    ).toEqual([]);
  });

  // Meta refuses both, after the reply is on the timeline marked failed. The
  // composer disables them; this is a stale tab or a second agent.
  it('refuses a comment deleted from the post, and answers the newest still on it', async () => {
    const { ticket, followUp } = await threadWithPasserBy();
    await deleteFromPost(followUp, 'post-1_c2');

    const refused = await reply(ticket, {
      metaSendKind: 'private_reply',
      replyToMessageId: followUp,
    });
    expect(refused.error).toBe(COMMENT_DELETED);
    expect(await replies(ticket)).toEqual([]);

    const state = await reply(ticket, { metaSendKind: 'private_reply' });
    expect(state.error).toBeNull();
    const [stored] = await replies(ticket);
    expect(stored!.meta).toMatchObject({ commentId: ROOT });
  });

  it('refuses a comment that already has a private reply, unless that one failed', async () => {
    const { ticket, followUp } = await threadWithPasserBy();

    expect((await reply(ticket, { metaSendKind: 'private_reply' })).error).toBeNull();
    const second = await reply(ticket, {
      metaSendKind: 'private_reply',
      replyToMessageId: followUp,
    });
    expect(second.error).toBe(COMMENT_ANSWERED);
    expect(await replies(ticket)).toHaveLength(1);

    // Graph refused the first, so it spent nothing.
    await db
      .update(messages)
      .set({ deliveryStatus: 'failed' })
      .where(and(eq(messages.conversationId, ticket), eq(messages.direction, 'outbound')));
    const retry = await reply(ticket, {
      metaSendKind: 'private_reply',
      replyToMessageId: followUp,
    });
    expect(retry.error).toBeNull();
    expect(await replies(ticket)).toHaveLength(2);
  });

  it('refuses when none of the comments is the requester’s', async () => {
    const { ticket, bob } = await threadWithPasserBy();
    // Every comment Bob's, as on a ticket whose requester's comments are gone.
    await db
      .update(messages)
      .set({ authorContactId: bob })
      .where(eq(messages.conversationId, ticket));

    const state = await reply(ticket, { metaSendKind: 'private_reply' });

    expect(state.error).toBe(NO_REQUESTER_COMMENT);
    expect(await replies(ticket)).toEqual([]);
  });
});

describe('a public reply on a comment ticket', () => {
  // Public either way, so nothing leaks; but the answer belongs under the
  // customer's words, and Bob can delete his comment and fail it.
  it('is posted under the requester’s newest comment on Facebook', async () => {
    const { ticket } = await threadWithPasserBy();

    const state = await reply(ticket, { metaSendKind: 'comment_reply' });
    expect(state.error).toBeNull();

    const [stored] = await replies(ticket);
    expect(stored!.meta).toMatchObject({
      sendKind: 'comment_reply',
      isPublic: true,
      commentId: 'post-1_c2',
    });

    await sendMeta(job(stored!.id));
    expect(addressed(graph.replyToComment)).toEqual(['post-1_c2']);
  });

  it('is posted under the comment it named, however the thread moves before the job runs', async () => {
    const { ticket, amira } = await threadWithPasserBy();

    await reply(ticket, { metaSendKind: 'comment_reply' });
    await comment(ticket, amira, 'post-1_c4', '2026-10-20T09:20:00Z');

    const [stored] = await replies(ticket);
    await sendMeta(job(stored!.id));
    expect(addressed(graph.replyToComment)).toEqual(['post-1_c2']);
  });

  // Graph refuses a reply under a comment that is gone; an older one of hers
  // still on the post takes it.
  it('is posted under her newest comment still on the post', async () => {
    const { ticket, followUp } = await threadWithPasserBy();
    await deleteFromPost(followUp, 'post-1_c2');

    await reply(ticket, { metaSendKind: 'comment_reply' });

    const [stored] = await replies(ticket);
    expect(stored!.meta).toMatchObject({ commentId: ROOT });
  });

  // The picker belongs to the private reply; a public one ignores a posted id.
  it('ignores a comment named by hand', async () => {
    const { ticket, passerBy } = await threadWithPasserBy();

    await reply(ticket, { metaSendKind: 'comment_reply', replyToMessageId: passerBy });

    const [stored] = await replies(ticket);
    expect(stored!.meta).toMatchObject({ commentId: 'post-1_c2' });
  });
});
