import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  automationRules,
  businessHours,
  channels,
  groupMembers,
  groups,
  ticketCategories,
} from '@/db/schema';
import { HEARTBEAT_TTL_MS } from '@/lib/assignment/eligibility';
import { saveCategoryAiSettings } from '@/lib/category-ai/settings';
import { resetEnvCache } from '@/lib/env';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { wallClockInstant } from '@/lib/hours/wall-clock';
import { withCleanDatabase } from '@/lib/testing/db';
import { routingReadiness, type ChannelRouting } from './readiness';

/**
 * The channels page's routing readiness against Postgres: every statement it
 * runs — the classifier's row, the categories, the groups with their members,
 * the hours catalog, the channels with their owners, the rules — planned and
 * answered on real rows, and judged as the code acting on each fact judges it.
 */

withCleanDatabase();

// A Sunday afternoon in Cairo, inside the seeded default week (09:00–17:00).
const NOW = wallClockInstant('2026-10-25T13:00', 'Africa/Cairo') as Date;
const FRESH = new Date(NOW.getTime() - 30_000);
const STALE = new Date(NOW.getTime() - HEARTBEAT_TTL_MS - 1_000);

let adminId = '';

beforeEach(async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
  resetEnvCache();
  const [admin] = await db
    .insert(agents)
    .values({ name: 'Mona Admin', email: 'mona@shipblu.test', role: 'admin' })
    .returning({ id: agents.id });
  adminId = admin!.id;
  await classifier('apply');
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

async function classifier(mode: 'off' | 'shadow' | 'apply') {
  await saveCategoryAiSettings({ mode, minProbability: 0.6, routingWindowMinutes: 5 }, adminId);
}

async function group(name: string, values: Partial<typeof groups.$inferInsert> = {}) {
  const [row] = await db
    .insert(groups)
    .values({ name, assignmentStrategy: 'round_robin', ...values })
    .returning({ id: groups.id });
  return row!.id;
}

async function member(groupId: string, name: string, values: Partial<typeof agents.$inferInsert>) {
  const [row] = await db
    .insert(agents)
    .values({
      name,
      email: `${name.toLowerCase()}@shipblu.test`,
      presence: 'online',
      lastSeenAt: FRESH,
      isAcceptingTickets: true,
      ...values,
    })
    .returning({ id: agents.id });
  await db.insert(groupMembers).values({ groupId, agentId: row!.id });
  return row!.id;
}

async function route(key: string, groupId: string | null) {
  await db
    .update(ticketCategories)
    .set({ routeGroupId: groupId })
    .where(eq(ticketCategories.key, key));
}

let order = 0;
async function channel(values: Partial<typeof channels.$inferInsert> & { name: string }) {
  // Spaced a minute apart, so "the oldest active row of a type" is the one
  // written first and not a tie broken by a random id.
  order += 1;
  const [row] = await db
    .insert(channels)
    .values({
      type: 'email',
      config: {},
      createdAt: new Date(NOW.getTime() - 86_400_000 + order * 60_000),
      ...values,
    })
    .returning({ id: channels.id });
  return row!.id;
}

const of = (readiness: { channels: ChannelRouting[] }, id: string) =>
  readiness.channels.find((row) => row.id === id)!;
const kinds = (row: ChannelRouting) => row.warnings.map((warning) => warning.kind);

describe('routingReadiness', () => {
  it('judges each active category’s route group as assignment would meet it now', async () => {
    const sales = await group('Sales');
    await member(sales, 'Here', {});
    const merchantCare = await group('Merchant Care', { assignmentStrategy: 'manual' });
    await member(merchantCare, 'Waiting', {});
    const customerCare = await group('Customer Care');
    await member(customerCare, 'Stale', { lastSeenAt: STALE });
    await member(customerCare, 'Paused', {
      isAcceptingTickets: false,
      acceptingOffReason: 'self',
    });
    // Its own calendar, shut on Sundays, and assigning only within it.
    const [weekdays] = await db
      .insert(businessHours)
      .values({
        name: 'Mondays only',
        schedule: {
          sun: [],
          mon: [{ start: '09:00', end: '17:00' }],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
        },
      })
      .returning({ id: businessHours.id });
    const couriers = await group('Couriers', { businessHoursId: weekdays!.id });
    await member(couriers, 'Rider', {});
    forgetHoursCatalog();

    await route('sales', sales);
    await route('merchant_support', merchantCare);
    await route('customer_support', customerCare);
    await route('courier_jobs', couriers);

    const readiness = await routingReadiness(NOW);

    expect(readiness.classifier).toEqual({ mode: 'apply', keyConfigured: true, windowMinutes: 5 });
    const byKey = Object.fromEntries(readiness.categories.map((row) => [row.key, row]));
    expect(byKey.sales).toMatchObject({
      routeGroup: {
        name: 'Sales',
        members: 1,
        acceptingNow: 1,
        hours: 'default',
        openNow: true,
        opensAt: null,
      },
      gaps: [],
    });
    expect(byKey.merchant_support!.gaps).toEqual(['manual']);
    expect(byKey.customer_support).toMatchObject({
      routeGroup: { members: 2, acceptingNow: 0 },
      gaps: ['nobody_accepting'],
    });
    expect(byKey.courier_jobs).toMatchObject({
      routeGroup: { hours: 'own', openNow: false },
      gaps: ['closed'],
    });
    // Monday 09:00 in Cairo, the next time its calendar opens.
    expect(byKey.courier_jobs!.routeGroup!.opensAt).toEqual(
      wallClockInstant('2026-10-26T09:00', 'Africa/Cairo'),
    );
  });

  it('leaves a retired category out, and a category with no route group routes nowhere', async () => {
    await db
      .update(ticketCategories)
      .set({ isActive: false })
      .where(eq(ticketCategories.key, 'courier_jobs'));
    const id = await channel({ name: 'Support mailbox', routingMode: 'category' });

    const readiness = await routingReadiness(NOW);

    expect(readiness.categories.map((row) => row.key)).not.toContain('courier_jobs');
    expect(readiness.categories.every((row) => row.routeGroup === null)).toBe(true);
    const warning = of(readiness, id).warnings.find((row) => row.kind === 'no_route_group');
    expect(warning).toMatchObject({ categories: expect.arrayContaining(['Sales']) });
  });

  it('says nothing about a channel on its default group, and gives every channel its saved mode', async () => {
    const id = await channel({ name: 'Support mailbox' });

    const readiness = await routingReadiness(NOW);

    expect(of(readiness, id)).toMatchObject({
      column: 'default_group',
      mode: 'default_group',
      starts: null,
      warnings: [],
    });
    // The seeded bot is there too: the forms read every row's mode from here.
    expect(readiness.channels.some((row) => row.type === 'whatsapp_bot')).toBe(true);
  });

  it('names the rows whose category mode the router never acts on', async () => {
    const coexistence = await channel({
      type: 'whatsapp',
      name: 'Business app',
      routingMode: 'category',
      config: {
        phoneNumberId: '106540352242922',
        coexistence: { onboardingId: null, onboardedAt: NOW.toISOString(), wabaId: '1', syncs: {} },
      },
    });
    const [bot] = await db
      .update(channels)
      .set({ routingMode: 'category_shadow' })
      .where(eq(channels.type, 'whatsapp_bot'))
      .returning({ id: channels.id });

    const readiness = await routingReadiness(NOW);

    expect(of(readiness, coexistence)).toMatchObject({
      column: 'category',
      mode: 'default_group',
      starts: null,
      warnings: [{ kind: 'never_routes', reason: 'coexistence' }],
    });
    expect(of(readiness, bot!.id).warnings).toEqual([{ kind: 'never_routes', reason: 'bot' }]);
  });

  it('starts routing only on the row tickets are filed under, active, unowned, with the classifier in Apply', async () => {
    const support = await group('Desk');
    await member(support, 'Here', {});
    const first = await channel({
      name: 'Support mailbox',
      routingMode: 'category',
      defaultGroupId: support,
    });
    const second = await channel({
      name: 'Second mailbox',
      routingMode: 'category',
      defaultGroupId: support,
    });
    const off = await channel({
      type: 'instagram',
      name: 'Instagram',
      routingMode: 'category_shadow',
      isActive: false,
      defaultGroupId: support,
    });
    const [owner] = await db
      .insert(agents)
      .values({ name: 'Nayera', email: 'nayera@shipblu.test' })
      .returning({ id: agents.id });
    const owned = await channel({
      type: 'whatsapp',
      name: 'Nayera',
      routingMode: 'category',
      config: { phoneNumberId: '106540352240000' },
      ownerAgentId: owner!.id,
      defaultGroupId: support,
    });

    const readiness = await routingReadiness(NOW);

    expect(of(readiness, first).starts).toBe('live');
    expect(of(readiness, second)).toMatchObject({
      starts: null,
      warnings: expect.arrayContaining([{ kind: 'not_filing_row', filingRow: 'Support mailbox' }]),
    });
    expect(of(readiness, off)).toMatchObject({ starts: null });
    expect(kinds(of(readiness, off))).toContain('inactive');
    expect(of(readiness, owned)).toMatchObject({
      starts: null,
      warnings: expect.arrayContaining([{ kind: 'owned', owner: 'Nayera' }]),
    });

    // An owner with no name is still an owner, and the warning names them by
    // email: keyed on the name, it went silent and the number read as routing.
    await db.update(agents).set({ name: '' }).where(eq(agents.id, owner!.id));
    expect(of(await routingReadiness(NOW), owned)).toMatchObject({
      starts: null,
      warnings: expect.arrayContaining([{ kind: 'owned', owner: 'nayera@shipblu.test' }]),
    });

    // A deactivated owner counts as nobody, so that number routes again.
    await db.update(agents).set({ isActive: false }).where(eq(agents.id, owner!.id));
    expect(of(await routingReadiness(NOW), owned).starts).toBe('live');
  });

  it('calls a category mode idle while the classifier is off or in Shadow, and blind with no key', async () => {
    const id = await channel({ name: 'Support mailbox', routingMode: 'category_shadow' });

    await classifier('shadow');
    let row = of(await routingReadiness(NOW), id);
    expect(row.starts).toBeNull();
    expect(row.warnings).toContainEqual({ kind: 'classifier_idle', classifier: 'shadow' });

    await classifier('apply');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    resetEnvCache();
    row = of(await routingReadiness(NOW), id);
    expect(row.starts).toBe('shadow');
    expect(kinds(row)).toContain('no_key');
    expect(kinds(row)).not.toContain('classifier_idle');
  });

  it('warns where routed tickets, and those that stay, would wait unassigned', async () => {
    const sales = await group('Sales', { assignmentStrategy: 'manual' });
    await member(sales, 'Here', {});
    const desk = await group('Desk');
    await route('sales', sales);
    // Routed to the channel's own group: those tickets stay, and are judged as staying.
    await route('customer_support', desk);
    const id = await channel({
      name: 'Support mailbox',
      routingMode: 'category',
      defaultGroupId: desk,
    });
    const nowhere = await channel({ type: 'webchat', name: 'Web chat', routingMode: 'category' });

    const readiness = await routingReadiness(NOW);

    const row = of(readiness, id);
    expect(row.warnings).toContainEqual({
      kind: 'route_gaps',
      categories: [{ label: 'Sales', group: 'Sales', gaps: ['manual'] }],
    });
    expect(row.warnings).toContainEqual(
      expect.objectContaining({ kind: 'default_group', gaps: ['unstaffed'] }),
    );
    expect(of(readiness, nowhere).warnings).toContainEqual({
      kind: 'default_group',
      group: null,
      gaps: [],
    });
  });

  it('names the active rules that would end a hold on the channel, and no others', async () => {
    const desk = await group('Desk');
    await member(desk, 'Here', {});
    const merchantCare = await group('Merchant Care');
    const [someone] = await db
      .insert(agents)
      .values({ name: 'Omar', email: 'omar@shipblu.test' })
      .returning({ id: agents.id });
    const webchat = await channel({
      type: 'webchat',
      name: 'Web chat',
      routingMode: 'category',
      defaultGroupId: desk,
    });
    const facebook = await channel({
      type: 'facebook',
      name: 'Facebook',
      routingMode: 'category_shadow',
      defaultGroupId: desk,
    });
    const chatOnly = { field: 'channel', op: 'eq', value: 'webchat' };
    await db.insert(automationRules).values([
      // Production's shape: every chat to a team, on creation.
      {
        name: 'Web chat to Merchant Care',
        trigger: 'on_create',
        conditions: chatOnly,
        actions: [{ type: 'assign_group', groupId: merchantCare }],
      },
      // Only some chats: it depends on what the ticket says.
      {
        name: 'Urgent chats to Omar',
        trigger: 'on_update',
        conditions: { all: [chatOnly, { field: 'priority', op: 'eq', value: 'urgent' }] },
        actions: [{ type: 'assign_agent', agentId: someone!.id }],
      },
      // A held ticket is unassigned, so this matches every chat.
      {
        name: 'Unassigned chats to the merchants rota',
        trigger: 'time_based',
        conditions: { field: 'is_assigned', op: 'eq', value: false },
        actions: [{ type: 'auto_assign', groupId: merchantCare, strategy: 'group_default' }],
      },
      // Never on a held ticket.
      {
        name: 'Assigned chats',
        trigger: 'on_update',
        conditions: { all: [chatOnly, { field: 'is_assigned', op: 'eq', value: true }] },
        actions: [{ type: 'assign_group', groupId: merchantCare }],
      },
      // The group a chat starts in: moves nothing.
      {
        name: 'Chats to the desk',
        trigger: 'on_create',
        conditions: chatOnly,
        actions: [{ type: 'assign_group', groupId: desk }],
      },
      // Assigns within the current group: held like any assignment.
      {
        name: 'Rota in place',
        trigger: 'on_create',
        conditions: {},
        actions: [{ type: 'auto_assign', groupId: null, strategy: 'group_default' }],
      },
      {
        name: 'Tag chats',
        trigger: 'on_update',
        conditions: chatOnly,
        actions: [{ type: 'add_tags', tags: ['chat'] }],
      },
      {
        name: 'Switched off',
        trigger: 'on_create',
        isActive: false,
        conditions: chatOnly,
        actions: [{ type: 'assign_group', groupId: merchantCare }],
      },
      {
        name: 'Malformed',
        trigger: 'on_create',
        conditions: { field: 'channel', op: 'resembles', value: 'webchat' },
        actions: [{ type: 'assign_group', groupId: merchantCare }],
      },
      // Comments are filed under the Facebook row while no comments row exists.
      {
        name: 'Comments to Merchant Care',
        trigger: 'on_create',
        conditions: { field: 'channel', op: 'eq', value: 'facebook_comment' },
        actions: [{ type: 'assign_group', groupId: merchantCare }],
      },
    ]);

    const readiness = await routingReadiness(NOW);

    const rulesOn = (id: string) =>
      of(readiness, id).warnings.find((warning) => warning.kind === 'rules');
    expect(rulesOn(webchat)).toEqual({
      kind: 'rules',
      rules: [
        expect.objectContaining({
          name: 'Web chat to Merchant Care',
          trigger: 'on_create',
          action: 'assign_group',
          groupName: 'Merchant Care',
          everyTicket: true,
        }),
        expect.objectContaining({
          name: 'Urgent chats to Omar',
          action: 'assign_agent',
          groupName: null,
          everyTicket: false,
        }),
        expect.objectContaining({
          name: 'Unassigned chats to the merchants rota',
          trigger: 'time_based',
          action: 'auto_assign',
          everyTicket: true,
        }),
      ],
    });
    expect(rulesOn(facebook)).toEqual({
      kind: 'rules',
      rules: [
        expect.objectContaining({ name: 'Comments to Merchant Care', everyTicket: false }),
        expect.objectContaining({
          name: 'Unassigned chats to the merchants rota',
          everyTicket: true,
        }),
      ],
    });

    // Once a comments row exists, the comments are its own.
    await channel({ type: 'facebook_comment', name: 'Facebook comments' });
    const after = (await routingReadiness(NOW)).channels.find((row) => row.id === facebook)!;
    expect(after.warnings.find((warning) => warning.kind === 'rules')).toEqual({
      kind: 'rules',
      rules: [expect.objectContaining({ name: 'Unassigned chats to the merchants rota' })],
    });
  });
});
