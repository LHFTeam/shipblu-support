import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  attachments,
  cannedResponses,
  cannedSuggestionSettings,
  cannedSuggestions,
  contacts,
  conversations,
  groupMembers,
  groups,
  messages,
  ticketStatuses,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { resetEnvCache } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { readHistory } from './history';
import { NONE_KEY, REQUEST_VERSION } from './request';
import {
  forgetSuggestionSettings,
  loadSuggestionSettings,
  saveSuggestionSettings,
} from './settings';
import { suggestFor } from './suggest';

/**
 * The suggester against a real database: what it reads, what it sends, what it
 * records, and when it does not ask at all. The provider is the one thing
 * faked — `fetch`, answered here — because what is being tested is everything
 * this system does around the call: the switch, the visibility of the ticket
 * and of each canned response, the cache that keeps it to one call per newest
 * message, and the row a failure leaves behind.
 */

withCleanDatabase();

beforeEach(() => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  resetEnvCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

async function signedIn(
  role: 'admin' | 'agent' = 'admin',
  email = 'omar@shipblu.test',
): Promise<SessionAgent> {
  const [row] = await db.insert(agents).values({ name: email, email, role }).returning();
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    role: row!.role,
    permissions: {},
    avatarUrl: null,
    avatarColor: row!.avatarColor,
    isAcceptingTickets: true,
    sessionIdleForMs: 0,
  };
}

async function ticket(
  channel: 'facebook' | 'email' | 'whatsapp_bot' = 'facebook',
  values: Partial<typeof conversations.$inferInsert> = {},
) {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel, statusId: open!.id, requesterContactId: contact!.id, ...values })
    .returning({ id: conversations.id });
  return row!.id;
}

// Each message a second after the last, so the order is the one written.
let clock = Date.parse('2026-10-01T09:00:00Z');

async function say(
  conversationId: string,
  text: string,
  values: Partial<typeof messages.$inferInsert> = {},
) {
  clock += 1000;
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      direction: 'inbound',
      bodyText: text,
      createdAt: new Date(clock),
      ...values,
    })
    .returning({ id: messages.id });
  return row!.id;
}

async function canned(values: Partial<typeof cannedResponses.$inferInsert> = {}) {
  const [row] = await db
    .insert(cannedResponses)
    .values({
      title: 'Where is my parcel',
      folder: 'Delivery',
      bodyTextAr: 'حضرتك الشحنة في الطريق.',
      bodyTextEn: 'Your parcel is on its way.',
      ...values,
    })
    .returning({ id: cannedResponses.id });
  return row!.id;
}

async function switchOn(agent: SessionAgent) {
  await saveSuggestionSettings(true, agent.id);
}

/** Jev, answering `choice` — a positional key the request offered, or `none`. */
function jev(choice: string, extra: { delayMs?: number; status?: number } = {}) {
  return stubFetch(async () => {
    if (extra.delayMs) await new Promise((resolve) => setTimeout(resolve, extra.delayMs));
    if (extra.status) return new Response('slow down', { status: extra.status });
    return Response.json({
      model: 'jev-1.13.0',
      answers: {
        canned_response: {
          type: 'choice',
          choice,
          probabilities: { [choice]: 0.8 },
          confidence: 0.6,
        },
      },
      usage: { input_tokens: 5123, output_tokens: 1 },
    });
  });
}

/** What the request offered, by title — read off the body the fake was sent. */
function offeredTitles(fetch: ReturnType<typeof stubFetch>): string[] {
  const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as {
    questions: { canned_response: { criteria: Record<string, string> } };
  };
  return Object.entries(body.questions.canned_response.criteria)
    .filter(([key]) => key !== NONE_KEY)
    .map(([, text]) => text.split(': ')[0]!);
}

async function rows() {
  return db.select().from(cannedSuggestions);
}

describe('readHistory', () => {
  it('reads replies both ways, oldest first, and never a note, a system line or a forward', async () => {
    const agent = await signedIn();
    const id = await ticket();
    await say(id, 'فين الشحنة');
    await say(id, 'Internal: merchant is on the watch list', {
      direction: 'outbound',
      kind: 'note',
      authorAgentId: agent.id,
    });
    await say(id, 'SLA breached', { direction: 'outbound', kind: 'system' });
    await say(id, 'We received your message', { direction: 'outbound' });
    await say(id, 'Let me check', { direction: 'outbound', authorAgentId: agent.id });
    const photo = await say(id, '');
    await db.insert(attachments).values({
      messageId: photo,
      storagePath: 'x/1',
      filename: 'a.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
    });

    const history = await readHistory(id);

    expect(history.messages).toEqual([
      { from: 'customer', text: 'فين الشحنة', attachments: 0 },
      { from: 'automatic_message', text: 'We received your message', attachments: 0 },
      { from: 'support_agent', text: 'Let me check', attachments: 0 },
      { from: 'customer', text: '', attachments: 1 },
    ]);
    expect(history.anchorMessageId).toBe(photo);
    expect(history.hasInbound).toBe(true);
  });

  it('reads the newest ten when there are more', async () => {
    const id = await ticket();
    for (let i = 0; i < 13; i++) await say(id, `m${i}`);

    const history = await readHistory(id);

    expect(history.messages.map((m) => m.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i + 3}`),
    );
  });
});

describe('the switch', () => {
  it('reads as off until somebody turns it on, and on once they have', async () => {
    const agent = await signedIn();
    expect((await loadSuggestionSettings()).enabled).toBe(false);

    await saveSuggestionSettings(true, agent.id);

    expect(await loadSuggestionSettings()).toMatchObject({ enabled: true, changedBy: agent.name });
  });

  it('holds one row: a second is refused by the database', async () => {
    await expect(
      db.insert(cannedSuggestionSettings).values({ id: 2, enabled: true }),
    ).rejects.toThrow();
  });
});

describe('suggestFor', () => {
  it('asks nothing and records nothing while switched off', async () => {
    const agent = await signedIn();
    const id = await ticket();
    await say(id, 'فين الشحنة');
    await canned();
    const fetch = jev('r1');

    expect(await suggestFor(agent, id)).toEqual({ state: 'none' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  // Production holds a key for the shadow categoriser, so the key cannot be the
  // switch — and a switch with no key must not pretend.
  it('asks nothing when switched on in an environment with no key', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    vi.stubEnv('TYPESAFE_API_KEY', '');
    resetEnvCache();
    forgetSuggestionSettings();
    const id = await ticket();
    await say(id, 'فين الشحنة');
    await canned();
    const fetch = jev('r1');

    expect(await suggestFor(agent, id)).toEqual({ state: 'none' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks once, and records the answer with what it cost', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket();
    await say(id, 'فين الشحنة');
    const anchor = await say(id, 'الشحنة اتأخرت');
    const where = await canned();
    const fetch = jev('r1');

    const answer = await suggestFor(agent, id);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({
      state: 'ready',
      suggestion: { cannedResponseId: where, anchorMessageId: anchor },
    });

    const [row] = await rows();
    expect(row).toMatchObject({
      conversationId: id,
      agentId: agent.id,
      anchorMessageId: anchor,
      channel: 'facebook',
      customerLocale: 'ar',
      requestVersion: REQUEST_VERSION,
      historyCount: 2,
      offeredIds: [where],
      model: 'jev-1.13.0',
      choice: where,
      cannedResponseId: where,
      cannedTitle: 'Where is my parcel',
      probability: 0.8,
      confidence: 0.6,
      probabilities: { [where]: 0.8 },
      inputTokens: 5123,
      error: null,
    });
    expect(row!.settledAt).toBeInstanceOf(Date);
    expect(row!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('answers the same newest message from the row, and a new one with a new call', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket();
    await say(id, 'فين الشحنة');
    await canned();
    const fetch = jev('r1');

    const first = await suggestFor(agent, id);
    const again = await suggestFor(agent, id);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(again).toEqual(first);

    await say(id, 'لسه موصلتش');
    await suggestFor(agent, id);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(2);
  });

  it("never offers another agent's personal response or a team's the agent is not on", async () => {
    const agent = await signedIn();
    const other = await signedIn('agent', 'nour@shipblu.test');
    await switchOn(agent);
    const [team] = await db.insert(groups).values({ name: 'Finance' }).returning();
    const [mine] = await db.insert(groups).values({ name: 'Ops' }).returning();
    await db.insert(groupMembers).values({ groupId: mine!.id, agentId: agent.id });

    await canned({ title: 'Global' });
    await canned({ title: 'Mine', visibility: 'personal', agentId: agent.id });
    await canned({ title: 'Theirs', visibility: 'personal', agentId: other.id });
    await canned({ title: 'My team', visibility: 'group', groupId: mine!.id });
    await canned({ title: 'Not my team', visibility: 'group', groupId: team!.id });

    const id = await ticket();
    await say(id, 'فين الشحنة');
    const fetch = jev(NONE_KEY);

    await suggestFor(agent, id);

    expect(offeredTitles(fetch).sort()).toEqual(
      ['Delivery › Global', 'Delivery › Mine', 'Delivery › My team'].sort(),
    );
  });

  it('records none as an answer, with nothing to show', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket();
    await say(id, 'شكرا');
    await canned();
    jev(NONE_KEY);

    const answer = await suggestFor(agent, id);

    expect(answer).toMatchObject({ state: 'ready', suggestion: { cannedResponseId: null } });
    expect((await rows())[0]).toMatchObject({
      choice: NONE_KEY,
      cannedResponseId: null,
      error: null,
    });
  });

  it('records a refusal from the provider, shows nothing, and does not ask again', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket();
    await say(id, 'فين الشحنة');
    await canned();
    const fetch = jev('r1', { status: 429 });

    expect(await suggestFor(agent, id)).toEqual({ state: 'none' });
    expect((await rows())[0]).toMatchObject({ choice: null });
    expect((await rows())[0]!.error).toMatch(/429/);

    expect(await suggestFor(agent, id)).toEqual({ state: 'none' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('records an answer naming an option nobody offered as a failure', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket();
    await say(id, 'فين الشحنة');
    await canned();
    jev('r99');

    expect(await suggestFor(agent, id)).toEqual({ state: 'none' });
    expect((await rows())[0]!.error).toMatch(/not one of the 2 options offered/);
  });

  it('answers a ticket the agent may not open as missing', async () => {
    const admin = await signedIn();
    await switchOn(admin);
    const agent = await signedIn('agent', 'nour@shipblu.test');
    const id = await ticket('facebook', { assigneeAgentId: admin.id });
    await say(id, 'فين الشحنة');
    await canned();
    const fetch = jev('r1');

    expect(await suggestFor(agent, id)).toBeNull();
    expect(await suggestFor(agent, 'not-a-uuid')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks nothing about a channel nobody replies on', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket('whatsapp_bot');
    await say(id, 'فين الشحنة');
    await canned();
    const fetch = jev('r1');

    expect(await suggestFor(agent, id)).toEqual({ state: 'none' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks nothing when the customer has said nothing yet', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket();
    await say(id, 'Hello from ShipBlu', { direction: 'outbound', authorAgentId: agent.id });
    await canned();
    const fetch = jev('r1');

    expect(await suggestFor(agent, id)).toEqual({ state: 'none' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });

  it('stops showing a suggestion that was waved away or whose response has gone, but still names the row', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket();
    await say(id, 'فين الشحنة');
    const where = await canned();
    jev('r1');

    const first = await suggestFor(agent, id);
    const suggestionId = first?.state === 'ready' ? first.suggestion.id : '';

    await db
      .update(cannedSuggestions)
      .set({ dismissedAt: new Date() })
      .where(eq(cannedSuggestions.id, suggestionId));
    expect(await suggestFor(agent, id)).toMatchObject({
      state: 'ready',
      suggestion: { id: suggestionId, cannedResponseId: null },
    });

    await db
      .update(cannedSuggestions)
      .set({ dismissedAt: null })
      .where(eq(cannedSuggestions.id, suggestionId));
    await db.delete(cannedResponses).where(eq(cannedResponses.id, where));
    expect(await suggestFor(agent, id)).toMatchObject({
      state: 'ready',
      suggestion: { id: suggestionId, cannedResponseId: null },
    });
    // Frozen, so the row still says what was suggested.
    expect((await rows())[0]).toMatchObject({ choice: where, cannedTitle: 'Where is my parcel' });
  });

  // Two tabs on one ticket, focused together: one call, and the loser waits.
  it('asks once when two requests race for the same message', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket();
    await say(id, 'فين الشحنة');
    await canned();
    const fetch = jev('r1', { delayMs: 200 });

    const answers = await Promise.all([suggestFor(agent, id), suggestFor(agent, id)]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(answers.map((answer) => answer?.state).sort()).toEqual(['pending', 'ready']);
    expect(await rows()).toHaveLength(1);
  });

  it('carries an email ticket’s subject, and nothing of the kind elsewhere', async () => {
    const agent = await signedIn();
    await switchOn(agent);
    const id = await ticket('email', { subject: 'COD not received' });
    await say(id, 'Where is my money?');
    await canned();
    const fetch = jev(NONE_KEY);

    await suggestFor(agent, id);

    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as {
      state: Record<string, unknown>;
    };
    expect(body.state).toMatchObject({ channel: 'email', email_subject: 'COD not received' });
  });
});
