import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  automationRules,
  cannedResponses,
  contacts,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
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

async function acknowledgeWith(cannedResponseId: string) {
  await db.insert(automationRules).values({
    name: 'Acknowledge',
    trigger: 'on_create',
    conditions: {},
    actions: [{ type: 'send_reply', cannedResponseId }],
  });
}

/** An email ticket whose requester last wrote `text`. */
async function ticketFrom(text: string) {
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
      channel: 'email',
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
