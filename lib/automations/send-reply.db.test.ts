import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  automationRules,
  cannedResponses,
  contacts,
  conversationEvents,
  conversations,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase, withoutCommentChannelCheck } from '@/lib/testing/db';
import { runAutomations } from './index';

/**
 * An automation's canned reply is sent, and is not counted as a use.
 *
 * `usage_count` and its language split say which responses agents reach for;
 * a rule sends its response to every ticket it matches, and counting that would
 * bury the agents' choices under one rule's volume. Asserted alongside the
 * reply actually going out — in the language chosen for the requester — because
 * a send that failed would leave the counts at zero too, and pass for the rule.
 */

withCleanDatabase();

async function cannedResponse(body: { ar: string; en: string }) {
  const [row] = await db
    .insert(cannedResponses)
    .values({ title: 'We have your message', bodyTextAr: body.ar, bodyTextEn: body.en })
    .returning({ id: cannedResponses.id });
  return row!.id;
}

async function acknowledgeWith(
  cannedResponseId: string,
  trigger: 'on_create' | 'on_update' = 'on_create',
) {
  await db.insert(automationRules).values({
    name: 'Acknowledge',
    trigger,
    conditions: {},
    actions: [{ type: 'send_reply', cannedResponseId }],
  });
}

/** A ticket, an email one unless told otherwise, whose requester last wrote `text`. */
async function ticketFrom(
  text: string,
  on: {
    channel: 'email' | 'facebook' | 'facebook_comment' | 'whatsapp_bot';
    externalId?: string;
  } = {
    channel: 'email',
  },
) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira', primaryEmail: `amira-${crypto.randomUUID()}@example.test` })
    .returning({ id: contacts.id });
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [conversation] = await db
    .insert(conversations)
    .values({
      channel: on.channel,
      externalId: on.externalId ?? null,
      statusId: open!.id,
      requesterContactId: contact!.id,
      // A minute back, so the rule's event is after it whatever the gap
      // between this process's clock and the database's — `alreadyReplied`
      // compares the two.
      lastCustomerMessageAt: new Date(Date.now() - 60_000),
    })
    .returning({ id: conversations.id });
  await db.insert(messages).values({
    conversationId: conversation!.id,
    direction: 'inbound',
    kind: 'reply',
    bodyText: text,
  });
  return conversation!.id;
}

async function countsOf(id: string) {
  const [row] = await db
    .select({
      total: cannedResponses.usageCount,
      ar: cannedResponses.usageCountAr,
      en: cannedResponses.usageCountEn,
    })
    .from(cannedResponses)
    .where(eq(cannedResponses.id, id));
  return row;
}

async function automatedReplyOn(conversationId: string) {
  const rows = await db
    .select({ bodyText: messages.bodyText })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')));
  return rows.map((row) => row.bodyText);
}

describe("an automation's canned reply", () => {
  // Posted under a comment where anybody reading the post sees it, addressed
  // to the requester, and under whichever comment came in last — which on a
  // busy thread is a passer-by's.
  it('is never sent on a public comment thread', async () => {
    const id = await cannedResponse({ ar: 'وصلتنا رسالتك.', en: 'We have your message.' });
    await acknowledgeWith(id);

    const comment = await ticketFrom('Where is my parcel?', {
      channel: 'facebook_comment',
      externalId: 'facebook:comment:post-1_c1',
    });
    const message = await ticketFrom('Where is my parcel?', { channel: 'facebook' });
    for (const ticket of [comment, message]) await runAutomations('on_create', ticket);

    expect(await automatedReplyOn(comment)).toEqual([]);
    // A direct message on the same platform is answered as it always was.
    expect(await automatedReplyOn(message)).toEqual(['We have your message.']);
  });

  // Nobody on the team writes to the customer bot's conversations, and the
  // reply would have been queued as an email (`carrierFor`): an edit on a bot
  // ticket fired an `on_update` rule, and nothing on that path refused it.
  it('is never sent on the customer bot’s conversation, nor queued as an email', async () => {
    const id = await cannedResponse({ ar: 'وصلتنا رسالتك.', en: 'We have your message.' });
    await acknowledgeWith(id, 'on_update');

    const bot = await ticketFrom('1', { channel: 'whatsapp_bot' });
    const mail = await ticketFrom('Where is my parcel?');
    for (const ticket of [bot, mail]) await runAutomations('on_update', ticket);

    expect(await automatedReplyOn(bot)).toEqual([]);
    expect(await automatedReplyOn(mail)).toEqual(['We have your message.']);
    // One carrier queued, for the email ticket's reply alone. Carriers only:
    // whatever else an `on_update` pass starts queuing is not this test's.
    const queued = await db
      .select({ type: jobs.type })
      .from(jobs)
      .where(inArray(jobs.type, ['send_email', 'send_whatsapp', 'send_meta']));
    expect(queued).toEqual([{ type: 'send_email' }]);
  });

  it('goes out in the language chosen for each requester and counts nothing', async () => {
    const id = await cannedResponse({ ar: 'وصلتنا رسالتك.', en: 'We have your message.' });
    await acknowledgeWith(id);

    const arabic = await ticketFrom('فين الشحنة بتاعتي؟ كان المفروض توصل امبارح');
    const english = await ticketFrom('Where is my parcel? It was due yesterday.');
    await runAutomations('on_create', arabic);
    await runAutomations('on_create', english);

    expect(await automatedReplyOn(arabic)).toEqual(['وصلتنا رسالتك.']);
    expect(await automatedReplyOn(english)).toEqual(['We have your message.']);
    expect(await countsOf(id)).toEqual({ total: 0, ar: 0, en: 0 });
  });

  // The rule's own record that it replied is the `auto_replied` event, which is
  // also what stops it replying twice — the count was never that record.
  it("records the reply as the rule's, once", async () => {
    const id = await cannedResponse({ ar: 'وصلتنا رسالتك.', en: '' });
    await acknowledgeWith(id);

    const english = await ticketFrom('Where is my parcel? It was due yesterday.');
    await runAutomations('on_create', english);
    await runAutomations('on_create', english);

    expect(await automatedReplyOn(english)).toEqual(['وصلتنا رسالتك.']);
    const events = await db
      .select({ actorLabel: conversationEvents.actorLabel })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, english),
          eq(conversationEvents.type, 'auto_replied'),
        ),
      );
    expect(events).toEqual([{ actorLabel: 'automation:Acknowledge' }]);
    expect(await countsOf(id)).toEqual({ total: 0, ar: 0, en: 0 });
  });
});

// The plan's rollback of Stage 1.2 moves every comment ticket back onto its
// platform's channel, where only its external id says the thread is public, and
// a rule matching it there would post under the comment.
describe("an automation's canned reply, once rolling back 1.2 has moved comments back", () => {
  const { moveCommentsBack } = withoutCommentChannelCheck();

  it('is still never sent on the comment thread', async () => {
    const id = await cannedResponse({ ar: 'وصلتنا رسالتك.', en: 'We have your message.' });
    await acknowledgeWith(id);

    const comment = await ticketFrom('Where is my parcel?', {
      channel: 'facebook_comment',
      externalId: 'facebook:comment:post-1_c1',
    });
    expect(await moveCommentsBack()).toBe(1);
    const message = await ticketFrom('Where is my parcel?', { channel: 'facebook' });
    for (const ticket of [comment, message]) await runAutomations('on_create', ticket);

    expect(await automatedReplyOn(comment)).toEqual([]);
    expect(await automatedReplyOn(message)).toEqual(['We have your message.']);
  });
});
