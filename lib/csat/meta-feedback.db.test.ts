import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  csatSurveys,
  jobs,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { fallBackToQuickReplies, sendSurvey } from '@/lib/csat';
import type { NormalisedFeedback } from '@/lib/meta/types';
import { withCleanDatabase } from '@/lib/testing/db';
import { recordMetaFeedback } from './meta-feedback';

/**
 * A survey answered on Facebook or Instagram, against real Postgres: only the
 * ticket's requester can answer it, the first answer wins whichever copy of
 * the delivery carries it, a tapped button is thanked once and reopens
 * nothing, and a card Messenger refused is carried on as quick replies.
 */

withCleanDatabase();

const HOUR = 3_600_000;

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status ${name}`);
  return row.id;
}

/** A resolved DM ticket whose customer is `psid` on `platform`, surveyed as `delivery`. */
async function surveyedTicket(input: {
  platform: 'facebook' | 'instagram';
  delivery: 'meta_template' | 'meta_quick_reply';
  lastWroteAt?: Date;
}) {
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  await db
    .insert(contactIdentities)
    .values({ contactId: contact!.id, channel: input.platform, identifier: 'psid-amira' });

  const lastWroteAt = input.lastWroteAt ?? new Date(Date.now() - HOUR);
  const [ticket] = await db
    .insert(conversations)
    .values({
      channel: input.platform,
      statusId: await statusId('Resolved'),
      requesterContactId: contact!.id,
      lastCustomerMessageAt: lastWroteAt,
    })
    .returning({ id: conversations.id });

  const sent = await sendSurvey({
    conversationId: ticket!.id,
    locale: 'en',
    delivery: input.delivery,
    snapshot: { agentId: null, groupId: null, channel: input.platform },
    resurveyAfterDays: 14,
    ruleId: null,
    requesterEmail: null,
    body: () => ({ text: 'Your ticket is resolved.\nHow did we do?', html: null }),
  });
  if (sent.kind !== 'sent') throw new Error(`no survey: ${sent.kind}`);

  return { conversationId: ticket!.id, contactId: contact!.id, lastWroteAt, ...sent };
}

function answer(surveyId: string, overrides: Partial<NormalisedFeedback> = {}): NormalisedFeedback {
  return {
    platform: 'instagram',
    connection: 'instagram_login',
    from: 'psid-amira',
    surveyId,
    rating: 5,
    comment: null,
    source: 'meta_quick_reply',
    ...overrides,
  };
}

async function surveyRow(surveyId: string) {
  const [row] = await db
    .select({
      status: csatSurveys.status,
      rating: csatSurveys.rating,
      comment: csatSurveys.comment,
      answerSource: csatSurveys.answerSource,
      delivery: csatSurveys.delivery,
      tokenHash: csatSurveys.tokenHash,
    })
    .from(csatSurveys)
    .where(eq(csatSurveys.id, surveyId));
  return row!;
}

/** The automated messages written after the survey itself. */
async function thanks(conversationId: string, surveyMessageId: string) {
  const rows = await db
    .select({ id: messages.id, bodyText: messages.bodyText })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')));
  return rows.filter((row) => row.id !== surveyMessageId);
}

describe('recordMetaFeedback', () => {
  it('records a tapped rating, thanks the customer once, and reopens nothing', async () => {
    const ticket = await surveyedTicket({ platform: 'instagram', delivery: 'meta_quick_reply' });

    expect(await recordMetaFeedback(answer(ticket.surveyId, { rating: 4 }))).toBe('recorded');
    expect(await surveyRow(ticket.surveyId)).toMatchObject({
      status: 'answered',
      rating: 4,
      answerSource: 'meta_quick_reply',
      // Nothing to answer a Meta survey with but the survey itself.
      tokenHash: null,
    });

    const written = await thanks(ticket.conversationId, ticket.messageId);
    expect(written).toHaveLength(1);
    expect(written[0]!.bodyText).toContain('Just reply here.');
    // Carried like any automated message on the channel.
    const carriers = await db
      .select({ dedupeKey: jobs.dedupeKey })
      .from(jobs)
      .where(eq(jobs.type, 'send_meta'));
    // The survey's own, queued with it, and the thanks'.
    expect(carriers.map((row) => row.dedupeKey).sort()).toEqual(
      [`send:${ticket.messageId}`, `send:${written[0]!.id}`].sort(),
    );

    // The other connection's copy of the same tap, and a second tap: the
    // first answer stands, and nobody is thanked twice.
    expect(await recordMetaFeedback(answer(ticket.surveyId, { rating: 4 }))).toBe('ignored');
    expect(await recordMetaFeedback(answer(ticket.surveyId, { rating: 1 }))).toBe('ignored');
    expect((await surveyRow(ticket.surveyId)).rating).toBe(4);
    expect(await thanks(ticket.conversationId, ticket.messageId)).toHaveLength(1);

    // An answer, not a message: the ticket stays resolved, and the window
    // and the next-response clock stay where the customer's words left them.
    const [after] = await db
      .select({
        status: ticketStatuses.category,
        lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      })
      .from(conversations)
      .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
      .where(eq(conversations.id, ticket.conversationId));
    expect(after!.status).toBe('resolved');
    expect(after!.lastCustomerMessageAt!.getTime()).toBe(ticket.lastWroteAt.getTime());

    const events = await db
      .select({ type: conversationEvents.type, data: conversationEvents.data })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, ticket.conversationId));
    expect(events.filter((event) => event.type === 'csat_received')).toEqual([
      { type: 'csat_received', data: { rating: 4, source: 'meta_quick_reply' } },
    ]);
    expect(events.filter((event) => event.type === 'csat_thanked')).toHaveLength(1);
    expect(events.some((event) => event.type === 'reopened')).toBe(false);
  });

  it('records the card’s answer with its comment, and leaves the thanks to Messenger', async () => {
    const ticket = await surveyedTicket({ platform: 'facebook', delivery: 'meta_template' });

    expect(
      await recordMetaFeedback(
        answer(ticket.surveyId, {
          platform: 'facebook',
          connection: 'facebook_page',
          source: 'meta_feedback',
          rating: 2,
          comment: 'The courier never called.',
        }),
      ),
    ).toBe('recorded');
    expect(await surveyRow(ticket.surveyId)).toMatchObject({
      rating: 2,
      comment: 'The courier never called.',
      answerSource: 'meta_feedback',
    });
    expect(await thanks(ticket.conversationId, ticket.messageId)).toEqual([]);
  });

  it('takes an answer only from the ticket’s requester, on the ticket’s platform', async () => {
    const ticket = await surveyedTicket({ platform: 'instagram', delivery: 'meta_quick_reply' });

    // Somebody who copied the survey's id into a payload of their own.
    const [stranger] = await db
      .insert(contacts)
      .values({ name: 'Somebody' })
      .returning({ id: contacts.id });
    await db
      .insert(contactIdentities)
      .values({ contactId: stranger!.id, channel: 'instagram', identifier: 'psid-stranger' });
    expect(await recordMetaFeedback(answer(ticket.surveyId, { from: 'psid-stranger' }))).toBe(
      'not_requester',
    );
    // Nobody this app knows.
    expect(await recordMetaFeedback(answer(ticket.surveyId, { from: 'psid-unknown' }))).toBe(
      'not_requester',
    );
    // The right id on the wrong platform: page-scoped ids mean nothing across them.
    expect(
      await recordMetaFeedback(
        answer(ticket.surveyId, { platform: 'facebook', connection: 'facebook_page' }),
      ),
    ).toBe('unknown_survey');
    // A survey that does not exist.
    expect(await recordMetaFeedback(answer('0b6a3f2e-9c41-4d7a-8e15-2f6c9d0a7b13'))).toBe(
      'unknown_survey',
    );

    expect(await surveyRow(ticket.surveyId)).toMatchObject({ status: 'sent', rating: null });
  });

  it('records a tap made after the window closed, without a reply that could not send', async () => {
    const ticket = await surveyedTicket({
      platform: 'instagram',
      delivery: 'meta_quick_reply',
      lastWroteAt: new Date(Date.now() - 30 * HOUR),
    });

    expect(await recordMetaFeedback(answer(ticket.surveyId, { rating: 3 }))).toBe('recorded');
    expect((await surveyRow(ticket.surveyId)).rating).toBe(3);
    expect(await thanks(ticket.conversationId, ticket.messageId)).toEqual([]);
  });
});

describe('fallBackToQuickReplies', () => {
  it('moves the survey and its message to quick replies, and says so on the timeline once', async () => {
    const ticket = await surveyedTicket({ platform: 'facebook', delivery: 'meta_template' });
    await db
      .update(messages)
      .set({ meta: { csatSurveyId: ticket.surveyId, sendKind: 'feedback_template' } })
      .where(eq(messages.id, ticket.messageId));

    await fallBackToQuickReplies(ticket.surveyId, ticket.messageId);
    // A retry of the carrier after a failure further on.
    await fallBackToQuickReplies(ticket.surveyId, ticket.messageId);

    expect((await surveyRow(ticket.surveyId)).delivery).toBe('meta_quick_reply');
    const [message] = await db
      .select({ meta: messages.meta })
      .from(messages)
      .where(eq(messages.id, ticket.messageId));
    expect(message!.meta).toEqual({
      csatSurveyId: ticket.surveyId,
      sendKind: 'quick_reply_survey',
    });
    const fellBack = await db
      .select({ id: conversationEvents.id })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, ticket.conversationId),
          eq(conversationEvents.type, 'csat_fell_back'),
        ),
      );
    expect(fellBack).toHaveLength(1);
  });
});
