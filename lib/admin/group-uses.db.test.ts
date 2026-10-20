import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  automationRules,
  cannedResponses,
  channels,
  contacts,
  conversations,
  groups,
  skills,
  slaPolicies,
  ticketForms,
  ticketStatuses,
  whatsappAccounts,
  whatsappOnboardings,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { storeBusinessToken } from '@/lib/whatsapp/credentials';
import { deleteGroupIfUnused, groupUses } from './group-uses';

/**
 * What still points at a group. The jsonb half is raw SQL that no other test
 * executes, which is why it is tested here against real Postgres rather than
 * trusted to `tsc`.
 */

withCleanDatabase();

const TARGET = { firstResponseMins: 60, nextResponseMins: null, resolutionMins: 1440 };
const TARGETS = { low: TARGET, medium: TARGET, high: TARGET, urgent: TARGET };

async function group(name: string): Promise<string> {
  const [row] = await db.insert(groups).values({ name }).returning({ id: groups.id });
  if (!row) throw new Error('group not inserted');
  return row.id;
}

async function stillThere(id: string): Promise<boolean> {
  const rows = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, id));
  return rows.length > 0;
}

describe('groupUses', () => {
  it('finds nothing for a group nothing names, and deletes it', async () => {
    const id = await group('Sales');

    expect(await groupUses(id)).toEqual({
      tickets: 0,
      channels: [],
      forms: [],
      onboardings: { connecting: 0, retryable: 0 },
      automationRules: [],
      slaPolicies: [],
      skills: [],
      cannedResponses: [],
    });
    expect(await deleteGroupIfUnused(id)).toBeNull();
    expect(await stillThere(id)).toBe(false);
    // Already gone is not a refusal: the admin wanted it gone.
    expect(await deleteGroupIfUnused(id)).toBeNull();
  });

  it('names every channel, form, rule, policy and skill that points at the group', async () => {
    const sales = await group('Sales');
    // Not 'Support': the baseline seeds that one.
    const other = await group('Merchant Care');

    await db.insert(channels).values([
      { type: 'email', name: 'Sales mailbox', defaultGroupId: sales },
      { type: 'webchat', name: 'Web chat', defaultGroupId: other },
    ]);
    await db
      .insert(ticketForms)
      .values({ slug: 'pricing', nameEn: 'Pricing', defaultGroupId: sales });

    await db.insert(automationRules).values([
      {
        name: 'Pricing to sales',
        trigger: 'on_create',
        conditions: {},
        actions: [{ type: 'assign_group', groupId: sales }],
      },
      {
        name: 'Sales is urgent',
        trigger: 'on_update',
        conditions: { field: 'group.id', op: 'eq', value: sales },
        actions: [{ type: 'set_priority', priority: 'urgent' }],
      },
      {
        name: 'Unrelated',
        trigger: 'on_create',
        conditions: { field: 'group.id', op: 'eq', value: other },
        actions: [],
      },
    ]);
    await db.insert(slaPolicies).values([
      {
        name: 'Live sales',
        targets: TARGETS,
        conditions: { any: [{ field: 'group.id', op: 'in', value: [sales] }] },
      },
      { name: 'Default', targets: TARGETS, isDefault: true },
    ]);
    await db.insert(skills).values([
      { name: 'Arabic pricing', conditions: { field: 'group.id', op: 'eq', value: sales } },
      { name: 'Merchant tooling', conditions: { field: 'group.id', op: 'eq', value: other } },
    ]);

    // Shared with the group: one a rule sends, which counts, and one nobody's
    // rule sends, which goes with the team. A rule sending a response shared
    // with another group does not make that one count here.
    const [sent, unsent, elsewhere] = await db
      .insert(cannedResponses)
      .values([
        { title: 'Sales hello', visibility: 'group', groupId: sales },
        { title: 'Sales goodbye', visibility: 'group', groupId: sales },
        { title: 'Merchant hello', visibility: 'group', groupId: other },
      ])
      .returning({ id: cannedResponses.id });
    await db.insert(automationRules).values([
      {
        name: 'Greet sales',
        trigger: 'on_create',
        conditions: {},
        actions: [{ type: 'send_reply', cannedResponseId: sent!.id }],
      },
      {
        name: 'Greet merchants',
        trigger: 'on_create',
        conditions: {},
        actions: [{ type: 'send_reply', cannedResponseId: elsewhere!.id }],
      },
    ]);
    expect(unsent).toBeDefined();

    const uses = await groupUses(sales);

    expect(uses.cannedResponses).toEqual(['Sales hello']);
    expect(uses.channels).toEqual(['Sales mailbox']);
    expect(uses.forms).toEqual(['Pricing']);
    expect(uses.automationRules).toEqual(['Pricing to sales', 'Sales is urgent']);
    expect(uses.slaPolicies).toEqual(['Live sales']);
    expect(uses.skills).toEqual(['Arabic pricing']);
    expect(await deleteGroupIfUnused(sales)).toBe(
      'That group is still in use: the default for channel “Sales mailbox”; the default for form “Pricing”; ' +
        'named by automation rules “Pricing to sales”, “Sales is urgent”; named by SLA policy “Live sales”; ' +
        'required by skill “Arabic pricing”; shared with canned response “Sales hello” that a rule sends. ' +
        'Move them to another group first.',
    );
    expect(await stillThere(sales)).toBe(true);
  });

  it('counts tickets, and only onboardings that could still create their channel', async () => {
    const sales = await group('Sales');
    const [status] = await db.select({ id: ticketStatuses.id }).from(ticketStatuses).limit(1);
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });
    await db.insert(conversations).values({
      statusId: status!.id,
      channel: 'email',
      groupId: sales,
      requesterContactId: contact!.id,
    });

    const [stored, unstored] = await db
      .insert(whatsappAccounts)
      .values([
        { name: 'Main', wabaId: 'waba-1' },
        { name: 'Second', wabaId: 'waba-2' },
      ])
      .returning({ id: whatsappAccounts.id });
    await db.transaction((tx) =>
      storeBusinessToken(tx, {
        accountId: stored!.id,
        wabaId: 'waba-1',
        token: 'EAAGm0PX4ZCpsBAgroupUsesTestToken0123456789',
        inspection: null,
        businessId: null,
        actor: null,
      }),
    );
    // A number that already has its channel: an attempt on it is a reconnect.
    await db
      .insert(channels)
      .values({ type: 'whatsapp', name: 'WhatsApp Support', config: { phoneNumberId: 'pn-9' } });

    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const attempt = (
      phoneNumberId: string,
      values: Partial<typeof whatsappOnboardings.$inferInsert>,
    ) => ({
      whatsappAccountId: stored!.id,
      wabaId: 'waba-1',
      phoneNumberId,
      status: 'failed' as const,
      defaultGroupId: sales,
      ...values,
    });
    await db.insert(whatsappOnboardings).values([
      // Running now, and will create its channel in this group.
      attempt('pn-1', { status: 'exchanged' }),
      // Failed yesterday on an account with a stored credential: the page
      // offers Retry, and the channel it creates would start in this group.
      attempt('pn-3', { error: 'Meta answered 500', finishedAt: ago(1) }),
      attempt('pn-2', { status: 'connected' }),
      // Past its channel step: the channel itself now holds the group.
      attempt('pn-4', {
        status: 'exchanged',
        channelId: '00000000-0000-4000-8000-000000000004',
      }),
      // Retired, and a retry refuses it.
      attempt('pn-5', { error: 'superseded', finishedAt: ago(1) }),
      // No stored credential, so the page offers no Retry, only a new sign-in.
      attempt('pn-7', {
        whatsappAccountId: unstored!.id,
        wabaId: 'waba-2',
        error: 'The worker stopped',
        finishedAt: ago(1),
      }),
      // Failed eight days ago: off the page, and nothing left to press.
      attempt('pn-8', { error: 'Meta answered 500', finishedAt: ago(8) }),
      // A reconnect keeps its channel's own group, whatever the attempt names.
      attempt('pn-9', { status: 'exchanged' }),
    ]);
    // Failed, and replaced by a newer attempt on the same number, which a retry
    // also refuses. The newer one names no group.
    await db
      .insert(whatsappOnboardings)
      .values(
        attempt('pn-6', { error: 'Meta answered 500', finishedAt: ago(1), createdAt: ago(2) }),
      );
    await db
      .insert(whatsappOnboardings)
      .values(attempt('pn-6', { status: 'connected', defaultGroupId: null, createdAt: ago(1) }));

    const uses = await groupUses(sales, db, now);

    expect(uses.tickets).toBe(1);
    // pn-1 running and pn-3 retryable. Counting every failed attempt not
    // replaced also took pn-7, pn-8 and pn-9, and kept the group for good.
    expect(uses.onboardings).toEqual({ connecting: 1, retryable: 1 });
    const refusal = await deleteGroupIfUnused(sales);
    expect(refusal).toContain('1 ticket(s)');
    expect(refusal).toContain('1 WhatsApp number(s) being connected now');
    expect(refusal).toContain(
      '1 failed WhatsApp connection(s) that “Retry connection” would still finish',
    );
    expect(refusal).toContain('a week after it failed');
    expect(await stillThere(sales)).toBe(true);
  });
});
