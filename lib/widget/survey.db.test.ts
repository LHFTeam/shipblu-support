import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  contacts,
  conversationEvents,
  conversations,
  csatRules,
  csatSurveys,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { recordAnswer, sendSurvey } from '@/lib/csat';
import { DEFAULT_WORDING, ratingLabels } from '@/lib/csat/wording';
import { withCleanDatabase } from '@/lib/testing/db';
import { answerSurvey, listMessages } from './conversation';

/**
 * The survey card against real Postgres: the transcript carries the survey a
 * message holds, in the words and the language it went out with; the
 * visitor's session answers it, and only theirs; an answer never reopens the
 * ticket; and a decision not to survey has nothing a card could answer.
 */

withCleanDatabase();

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!row) throw new Error(`no status ${name}`);
  return row.id;
}

/** A visitor, and a resolved web chat of theirs with one thing they said. */
async function resolvedChat() {
  const [contact] = await db.insert(contacts).values({ name: null }).returning({ id: contacts.id });
  const [chat] = await db
    .insert(conversations)
    .values({
      channel: 'webchat',
      statusId: await statusId('Resolved'),
      requesterContactId: contact!.id,
      lastCustomerMessageAt: new Date(),
    })
    .returning({ id: conversations.id });
  await db.insert(messages).values({
    conversationId: chat!.id,
    direction: 'inbound',
    kind: 'reply',
    authorContactId: contact!.id,
    bodyText: 'Where is my parcel?',
  });
  return { contactId: contact!.id, conversationId: chat!.id };
}

async function survey(conversationId: string, locale: 'ar' | 'en', ruleId: string | null = null) {
  const sent = await sendSurvey({
    conversationId,
    locale,
    delivery: 'widget_card',
    snapshot: { agentId: null, groupId: null, channel: 'webchat' },
    resurveyAfterDays: 14,
    ruleId,
    requesterEmail: null,
    body: (url) => ({ text: `How did we do?\n${url}`, html: null }),
  });
  if (sent.kind !== 'sent') throw new Error(`no survey: ${sent.kind}`);
  return sent;
}

async function row(surveyId: string) {
  const [found] = await db
    .select({
      status: csatSurveys.status,
      rating: csatSurveys.rating,
      comment: csatSurveys.comment,
      answerSource: csatSurveys.answerSource,
    })
    .from(csatSurveys)
    .where(eq(csatSurveys.id, surveyId));
  return found;
}

describe('the survey card', () => {
  it('rides on the message that carries the survey, in the words it went out with', async () => {
    const { conversationId } = await resolvedChat();
    const [rule] = await db
      .insert(csatRules)
      .values({ channel: 'webchat', questionAr: 'كيف كانت المحادثة؟' })
      .returning({ id: csatRules.id });
    const sent = await survey(conversationId, 'ar', rule!.id);

    const transcript = await listMessages(conversationId);

    expect(transcript[0]!.survey).toBeNull();
    const carrier = transcript.find((message) => message.id === sent.messageId)!;
    expect(carrier.body).toContain('/ar/csat/');
    expect(carrier.survey).toEqual({
      id: sent.surveyId,
      rating: null,
      expired: false,
      locale: 'ar',
      intro: DEFAULT_WORDING.ar.intro,
      question: 'كيف كانت المحادثة؟',
      labels: ratingLabels('ar'),
      commentPrompt: DEFAULT_WORDING.ar.commentPrompt,
      button: DEFAULT_WORDING.ar.button,
      thanks: DEFAULT_WORDING.ar.thanks,
    });
    // The card's fields are exactly these: no token, no hash. The link is the
    // body's, which is the visitor's own.
  });

  it('takes the visitor’s rating and then their comment, without reopening the ticket', async () => {
    const { contactId, conversationId } = await resolvedChat();
    const sent = await survey(conversationId, 'en');
    const resolved = await statusId('Resolved');

    expect(await answerSurvey(contactId, sent.surveyId, 4, null)).toBe(4);
    expect(await answerSurvey(contactId, sent.surveyId, 4, '  Quick, thank you  ')).toBe(4);
    // First answer wins, from whichever door, and the card is told which one
    // was kept rather than drawing its second tap.
    expect(await answerSurvey(contactId, sent.surveyId, 1, 'changed my mind')).toBe(4);
    expect(await recordAnswer(sent.surveyId, 1, null, 'page')).toBe('ignored');

    expect(await row(sent.surveyId)).toEqual({
      status: 'answered',
      rating: 4,
      comment: 'Quick, thank you',
      answerSource: 'widget',
    });

    const [ticket] = await db
      .select({ statusId: conversations.statusId })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(ticket!.statusId).toBe(resolved);

    const received = await db
      .select({ data: conversationEvents.data })
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.conversationId, conversationId),
          eq(conversationEvents.type, 'csat_received'),
        ),
      );
    expect(received.map((event) => event.data)).toEqual([{ rating: 4, source: 'widget' }]);

    const carrier = (await listMessages(conversationId)).find(
      (message) => message.id === sent.messageId,
    )!;
    expect(carrier.survey).toMatchObject({ rating: 4, expired: false });
  });

  it('answers nothing for a visitor whose chat the survey is not on', async () => {
    const { conversationId } = await resolvedChat();
    const stranger = await resolvedChat();
    const sent = await survey(conversationId, 'en');

    expect(await answerSurvey(stranger.contactId, sent.surveyId, 5, 'great')).toBeNull();
    expect(await row(sent.surveyId)).toMatchObject({ status: 'sent', rating: null });
  });

  it('draws a superseded, unanswered survey closed, and takes no answer for it from the card', async () => {
    const { contactId, conversationId } = await resolvedChat();
    const first = await survey(conversationId, 'en');
    // Past the window, so the next resolution surveys again and retires the first.
    await db
      .update(csatSurveys)
      .set({ sentAt: new Date(Date.now() - 30 * 24 * 3_600_000) })
      .where(eq(csatSurveys.id, first.surveyId));
    const second = await survey(conversationId, 'en');

    const cards = new Map(
      (await listMessages(conversationId)).map((message) => [message.id, message.survey]),
    );
    expect(cards.get(first.messageId)).toMatchObject({ expired: true, rating: null });
    expect(cards.get(second.messageId)).toMatchObject({ expired: false, rating: null });

    // The card's door agrees with the card; the link still takes one, as it
    // always did.
    expect(await answerSurvey(contactId, first.surveyId, 2, null)).toBeNull();
    expect(await row(first.surveyId)).toMatchObject({ status: 'expired', rating: null });
    expect(await recordAnswer(first.surveyId, 2, null, 'page')).toBe('recorded');
    expect(await row(first.surveyId)).toMatchObject({ status: 'answered', answerSource: 'page' });
  });

  it('never turns a decision not to survey into an answer', async () => {
    const { contactId, conversationId } = await resolvedChat();
    const [skipped] = await db
      .insert(csatSurveys)
      .values({ conversationId, status: 'skipped', skipReason: 'agent_suppressed' })
      .returning({ id: csatSurveys.id });

    expect(await recordAnswer(skipped!.id, 5, 'great', 'widget')).toBe('ignored');
    expect(await answerSurvey(contactId, skipped!.id, 5, null)).toBeNull();
    expect(await row(skipped!.id)).toMatchObject({ status: 'skipped', rating: null });
  });
});
