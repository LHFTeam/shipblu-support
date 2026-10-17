import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The survey's Messenger card through `send_meta`, against real Postgres with
 * Graph stood in for: the card goes out with the tag its window allows, a
 * refusal of the card is kept for the admin page and the survey goes on as
 * rating buttons inside the 24 hours, a refusal about the customer is neither,
 * and a card that goes out takes the last refusal down.
 */

const graph = vi.hoisted(() => ({ sendMessageRequest: vi.fn() }));

vi.mock('@/lib/meta/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meta/client')>()),
  sendMessageRequest: graph.sendMessageRequest,
}));
// Which host and token: the environment's, and nothing this test is about.
vi.mock('@/lib/meta/connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/meta/connection')>()),
  metaConnection: () => 'facebook_page',
}));
// The thread is answerable and the customer is PSID-1; `metaReplyTarget`'s
// own reading of thread control has its tests.
vi.mock('@/lib/tickets/meta-thread', () => ({
  metaReplyTarget: async () => ({ recipientId: 'PSID-1', thread: { canSend: true } }),
}));

const { db } = await import('@/db/client');
const {
  agents,
  contacts,
  conversationEvents,
  conversations,
  csatSettings,
  csatSurveys,
  messages,
  ticketStatuses,
} = await import('@/db/schema');
const { sendSurvey } = await import('@/lib/csat');
const { metaSurveyMessage } = await import('@/lib/csat/meta-survey');
const { saveCsatSettings, UNSET_CSAT_SETTINGS } = await import('@/lib/csat/settings');
const { DEFAULT_WORDING } = await import('@/lib/csat/wording');
const { MetaApiError } = await import('@/lib/meta/client');
const { withCleanDatabase } = await import('@/lib/testing/db');
const { sendMeta } = await import('./send-meta');

withCleanDatabase();

const HOUR = 3_600_000;
const SETTINGS = { privacyUrl: 'https://shipblu.com/privacy', metaExpiresInDays: 3 };

beforeEach(() => {
  graph.sendMessageRequest.mockReset();
});

async function settingsOn() {
  const [admin] = await db
    .insert(agents)
    .values({ name: 'Admin', email: 'admin@shipblu.test', role: 'admin' })
    .returning({ id: agents.id });
  await saveCsatSettings(
    {
      ...UNSET_CSAT_SETTINGS,
      ...SETTINGS,
      enabled: true,
      channels: { ...UNSET_CSAT_SETTINGS.channels, facebook: true },
    },
    admin!.id,
  );
}

/** A resolved Facebook DM whose customer last wrote `ago` back, carrying a card survey. */
async function cardSurvey(ago: number) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Resolved'));
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [ticket] = await db
    .insert(conversations)
    .values({
      channel: 'facebook',
      statusId: status!.id,
      requesterContactId: contact!.id,
      lastCustomerMessageAt: new Date(Date.now() - ago),
    })
    .returning({ id: conversations.id });

  const sent = await sendSurvey({
    conversationId: ticket!.id,
    locale: 'en',
    delivery: 'meta_template',
    snapshot: { agentId: null, groupId: null, channel: 'facebook' },
    resurveyAfterDays: 14,
    ruleId: null,
    requesterEmail: null,
    body: () => metaSurveyMessage(DEFAULT_WORDING.en, 'en', 'meta_template', SETTINGS),
  });
  if (sent.kind !== 'sent') throw new Error(`no survey: ${sent.kind}`);
  return { conversationId: ticket!.id, ...sent };
}

function job(
  messageId: string,
  attempt: { attempts: number; maxAttempts: number } = {
    attempts: 1,
    maxAttempts: 5,
  },
) {
  return { id: 'job-1', type: 'send_meta', payload: { messageId }, ...attempt } as never;
}

async function state(survey: { surveyId: string; messageId: string; conversationId: string }) {
  const [message] = await db
    .select({ status: messages.deliveryStatus, meta: messages.meta, error: messages.deliveryError })
    .from(messages)
    .where(eq(messages.id, survey.messageId));
  const [row] = await db
    .select({ delivery: csatSurveys.delivery })
    .from(csatSurveys)
    .where(eq(csatSurveys.id, survey.surveyId));
  const [settings] = await db
    .select({ refusal: csatSettings.lastTemplateRefusal })
    .from(csatSettings);
  const fellBack = await db
    .select({ id: conversationEvents.id })
    .from(conversationEvents)
    .where(
      and(
        eq(conversationEvents.conversationId, survey.conversationId),
        eq(conversationEvents.type, 'csat_fell_back'),
      ),
    );
  return {
    message: message!,
    delivery: row!.delivery,
    refusal: settings!.refusal,
    fellBack: fellBack.length,
  };
}

/** What each request asked Graph for: the card, or the buttons, and with which tag. */
function requests() {
  return graph.sendMessageRequest.mock.calls.map(([, body]) => {
    const request = body as {
      tag?: string;
      messaging_type?: string;
      message: { attachment?: unknown; quick_replies?: unknown[] };
    };
    return {
      kind: request.message.attachment ? 'card' : 'buttons',
      messagingType: request.messaging_type,
      tag: request.tag ?? null,
    };
  });
}

describe('send_meta, for a survey card', () => {
  it('sends the card with its own tag past the 24 hours, and takes a stale refusal down', async () => {
    await settingsOn();
    await db.update(csatSettings).set({
      lastTemplateRefusal: 'An earlier refusal',
      lastTemplateRefusalAt: new Date(Date.now() - 48 * HOUR),
    });
    const survey = await cardSurvey(3 * 24 * HOUR);
    graph.sendMessageRequest.mockResolvedValueOnce({
      messageId: 'mid.card',
      recipientId: 'PSID-1',
    });

    await sendMeta(job(survey.messageId));

    expect(requests()).toEqual([
      { kind: 'card', messagingType: 'MESSAGE_TAG', tag: 'CUSTOMER_FEEDBACK' },
    ]);
    expect(await state(survey)).toMatchObject({
      message: { status: 'sent' },
      delivery: 'meta_template',
      refusal: null,
      fellBack: 0,
    });
  });

  it('keeps a refusal of the card and sends rating buttons instead, inside the 24 hours', async () => {
    await settingsOn();
    const survey = await cardSurvey(HOUR);
    graph.sendMessageRequest
      .mockRejectedValueOnce(
        new MetaApiError('(#100) Unsupported post request.', 400, 100, null, false),
      )
      .mockResolvedValueOnce({ messageId: 'mid.buttons', recipientId: 'PSID-1' });

    await sendMeta(job(survey.messageId));

    expect(requests()).toEqual([
      { kind: 'card', messagingType: 'RESPONSE', tag: null },
      { kind: 'buttons', messagingType: 'RESPONSE', tag: null },
    ]);
    const after = await state(survey);
    expect(after).toMatchObject({
      message: { status: 'sent', meta: { sendKind: 'quick_reply_survey' } },
      delivery: 'meta_quick_reply',
      fellBack: 1,
    });
    expect(after.refusal).toContain('Unsupported post request');
  });

  it('keeps the refusal but has nothing to fall back to past the 24 hours', async () => {
    await settingsOn();
    const survey = await cardSurvey(3 * 24 * HOUR);
    graph.sendMessageRequest.mockRejectedValueOnce(
      new MetaApiError('(#100) Unsupported post request.', 400, 100, null, false),
    );

    await sendMeta(job(survey.messageId));

    expect(requests()).toHaveLength(1);
    const after = await state(survey);
    expect(after).toMatchObject({
      message: { status: 'failed' },
      delivery: 'meta_template',
      fellBack: 0,
    });
    expect(after.refusal).toContain('Unsupported post request');
  });

  it('retries the card through a transient refusal, and counts it as the card’s on the last try', async () => {
    await settingsOn();
    const survey = await cardSurvey(HOUR);
    // What Graph says to most refusals, a withdrawn card's quite possibly.
    const unknown = () => new MetaApiError('An unknown error has occurred.', 500, 2, null, true);

    graph.sendMessageRequest.mockRejectedValueOnce(unknown());
    await expect(sendMeta(job(survey.messageId))).rejects.toThrow('An unknown error');
    // A blip, until the queue says otherwise: retried as the card.
    expect(requests()).toEqual([{ kind: 'card', messagingType: 'RESPONSE', tag: null }]);
    expect(await state(survey)).toMatchObject({
      delivery: 'meta_template',
      refusal: null,
      fellBack: 0,
    });

    graph.sendMessageRequest
      .mockRejectedValueOnce(unknown())
      .mockResolvedValueOnce({ messageId: 'mid.buttons', recipientId: 'PSID-1' });
    await sendMeta(job(survey.messageId, { attempts: 5, maxAttempts: 5 }));

    // The last try: the card counts as refused, said on the page, and the
    // buttons go while the 24 hours are open.
    expect(requests().slice(1)).toEqual([
      { kind: 'card', messagingType: 'RESPONSE', tag: null },
      { kind: 'buttons', messagingType: 'RESPONSE', tag: null },
    ]);
    const after = await state(survey);
    expect(after).toMatchObject({
      message: { status: 'sent' },
      delivery: 'meta_quick_reply',
      fellBack: 1,
    });
    expect(after.refusal).toContain('An unknown error');
  });

  it('does not blame the card for a customer who cannot be reached', async () => {
    await settingsOn();
    const survey = await cardSurvey(HOUR);
    graph.sendMessageRequest.mockRejectedValueOnce(
      new MetaApiError("(#551) This person isn't available right now.", 400, 551, 1545041, false),
    );

    await sendMeta(job(survey.messageId));

    // One request: buttons to somebody who blocked the Page would be refused too.
    expect(requests()).toHaveLength(1);
    expect(await state(survey)).toMatchObject({
      message: { status: 'failed' },
      delivery: 'meta_template',
      refusal: null,
      fellBack: 0,
    });
  });
});
