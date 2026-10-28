import { eq } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  categoryAiSettings,
  channels,
  contacts,
  conversations,
  groups,
  routingDecisions,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import RoutingReportPage from './page';

/**
 * The page as it renders against the database: what it says before anything
 * has routed, and the notices built from state rather than from the figures —
 * the parts a reader meets first, and the parts no query test can see.
 *
 * Rendered to static markup with the session stubbed: the page is an async
 * server component whose children are all synchronous, so awaiting it gives
 * the element tree React renders.
 */

const viewer = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
}));

vi.mock('@/lib/auth/guard', () => ({
  requireAgent: () => Promise.resolve({ id: 'viewer', role: viewer.role, permissions: {} }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

withCleanDatabase();

beforeEach(() => {
  viewer.role = 'admin';
});

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE);

async function render(days = '7'): Promise<string> {
  const page = await RoutingReportPage({ searchParams: Promise.resolve({ days }) });
  return renderToStaticMarkup(createElement('div', null, page));
}

async function classifier(mode: 'off' | 'shadow' | 'apply') {
  await db.insert(categoryAiSettings).values({ id: 1, mode, routingWindowMinutes: 5 });
}

async function channel(values: Partial<typeof channels.$inferInsert> & { name: string }) {
  const [row] = await db
    .insert(channels)
    .values({ type: 'webchat', config: {}, ...values })
    .returning({ id: channels.id });
  return row!.id;
}

async function routed(
  values: Partial<typeof routingDecisions.$inferInsert> & { startedAt: Date },
  ticket: Partial<typeof conversations.$inferInsert> = {},
) {
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db
    .insert(contacts)
    .values({ name: 'Amira' })
    .returning({ id: contacts.id });
  const [row] = await db
    .insert(conversations)
    .values({ requesterContactId: contact!.id, statusId: open!.id, channel: 'webchat', ...ticket })
    .returning({ id: conversations.id, number: conversations.number });
  const windowEndsAt = new Date(values.startedAt.getTime() + 5 * MINUTE);
  await db.insert(routingDecisions).values({
    conversationId: row!.id,
    shadow: false,
    stage: values.outcome ? 'decided' : 'holding',
    windowEndsAt,
    ...(values.outcome ? { decidedAt: windowEndsAt } : {}),
    ...values,
  });
  return row!;
}

describe('the routing report page', () => {
  it('is not there for somebody who may not read the team’s reports', async () => {
    viewer.role = 'agent';
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('says which of the two switches is missing before anything has routed', async () => {
    const html = await render();
    expect(html).toContain('Nothing has entered routing yet');
    expect(html).toContain('The classifier is switched off.');
    expect(html).toContain('Every active channel is on Default group.');
  });

  it('reads a channel’s mode as the router does, not off the column', async () => {
    await classifier('apply');
    await channel({ name: 'Web chat', routingMode: 'category' });
    // The column says category; a coexistence number never routes.
    await channel({
      name: 'Business app',
      type: 'whatsapp',
      routingMode: 'category',
      config: {
        phoneNumberId: '1092',
        coexistence: { onboardedAt: '2026-09-01T10:00:00.000Z', wabaId: 'waba-1' },
      },
    });

    const html = await render();
    expect(html).toContain('Both are set, so the next new ticket on Web chat enters routing.');
    expect(html).not.toContain('Business app');
  });

  it('warns that a category mode is idle while the classifier is not in Apply', async () => {
    await classifier('shadow');
    await channel({ name: 'Web chat', routingMode: 'category' });

    const html = await render();
    expect(html).toContain('Idle until the category classifier is in Apply');
    expect(html).toContain('The classifier is in Shadow, filing nothing.');
  });

  it('says when the window holds nothing, and when the last ticket entered', async () => {
    await classifier('apply');
    const id = await channel({ name: 'Web chat', routingMode: 'category' });
    await routed({ channelId: id, startedAt: ago(20 * 24 * 60), outcome: 'fallback' });

    const html = await render('7');
    expect(html).toContain('No ticket entered routing between');
    expect(html).toContain('The last one entered on');
  });

  it('names what is open now: stranded records, their recovery, and a manual group apart', async () => {
    await classifier('apply');
    const chat = await channel({ name: 'Web chat', routingMode: 'category' });
    await channel({ name: 'Mail', type: 'email', routingMode: 'category' });
    const [queue] = await db
      .insert(groups)
      .values({ name: 'Merchant queue', assignmentStrategy: 'manual' })
      .returning({ id: groups.id });

    await routed(
      { channelId: chat, startedAt: ago(120), outcome: 'category' },
      { groupId: queue!.id },
    );
    const stuck = await routed({ channelId: chat, startedAt: ago(60) });

    const html = await render();
    // The window opens days before the first ticket routed.
    expect(html).toContain('but the first ticket entered routing on');
    // A channel set to route that had nothing enter is a line, not an absence.
    expect(html).toContain('Nothing entered routing in this window.');
    expect(html).toContain('settle_routing conversationId=');
    expect(html).toContain(`conversationId=${stuck.id}`);
    // Waiting in a manual group is the design, and counted apart.
    expect(html).toContain('Manual: picked from the queue');
    expect(html).toContain('and 1 in manual groups');
    // One sentence per stranded record, the channel inline: its badge-and-name
    // box broke the line into three.
    expect(html).toMatch(/Live · <span dir="auto">Web chat<\/span> · window ended /);
  });

  it('says a share of fewer than ten once, and the window lengths as a sentence', async () => {
    await classifier('apply');
    const chat = await channel({ name: 'Web chat', routingMode: 'category' });
    const start = ago(3 * 60);
    await routed({ channelId: chat, startedAt: start, outcome: 'category' });
    await routed({ channelId: chat, startedAt: start, outcome: 'fallback' });
    // The window was ten minutes when this one entered.
    await routed({
      channelId: chat,
      startedAt: start,
      outcome: 'fallback',
      windowEndsAt: new Date(start.getTime() + 10 * MINUTE),
    });

    const html = await render();
    // The tile already reads "1 of 3"; the line under it says what the 3 is.
    expect(html).toContain('1 of 3');
    expect(html).not.toContain('1 of 3 the router decided');
    expect(html).toContain('Of the decisions the router made itself, live');
    expect(html).toContain('windows of 5 and 10 minutes');
  });

  it('draws the shares beside where each channel stands, and the router’s outcomes first', async () => {
    await classifier('apply');
    const chat = await channel({ name: 'Web chat', routingMode: 'category' });
    await routed({ channelId: chat, startedAt: ago(60), outcome: 'category' });

    const html = await render();
    const [standing, byOutcome] = html.split('Decided, by outcome');
    // The shares are what a reader comes for: in the first, narrower table.
    expect(standing).toContain('Ran out, of the router’s');
    expect(byOutcome).not.toContain('Ran out, of the router’s');
    const headers = [...byOutcome!.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) => match[1]);
    expect(headers.slice(0, 9)).toEqual([
      'Channel',
      'Routed',
      'No route for its category',
      'Window ran out',
      'Already taken',
      'A person decided first',
      'A rule decided first',
      'No longer open',
      'Channel stopped routing',
    ]);
  });
});
