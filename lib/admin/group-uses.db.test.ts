import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  automationRules,
  channels,
  contacts,
  conversations,
  groups,
  slaPolicies,
  ticketForms,
  ticketStatuses,
  whatsappAccounts,
  whatsappOnboardings,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { groupDeleteRefusal, groupUses } from './group-uses';

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

describe('groupUses', () => {
  it('finds nothing for a group nothing names', async () => {
    const id = await group('Sales');
    const uses = await groupUses(id);

    expect(uses).toEqual({
      tickets: 0,
      channels: [],
      forms: [],
      onboardings: 0,
      automationRules: [],
      slaPolicies: [],
    });
    expect(groupDeleteRefusal(uses)).toBeNull();
  });

  it('names every channel, form, rule and policy that points at the group', async () => {
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

    const uses = await groupUses(sales);

    expect(uses.channels).toEqual(['Sales mailbox']);
    expect(uses.forms).toEqual(['Pricing']);
    expect(uses.automationRules).toEqual(['Pricing to sales', 'Sales is urgent']);
    expect(uses.slaPolicies).toEqual(['Live sales']);
    expect(groupDeleteRefusal(uses)).toBe(
      'That group is still in use: the default for channel “Sales mailbox”; the default for form “Pricing”; ' +
        'named by automation rules “Pricing to sales”, “Sales is urgent”; named by SLA policy “Live sales”. ' +
        'Move them to another group first.',
    );
  });

  it('counts tickets, and only onboardings still waiting to create their channel', async () => {
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

    const [account] = await db
      .insert(whatsappAccounts)
      .values({ name: 'Main', wabaId: 'waba-1' })
      .returning({ id: whatsappAccounts.id });
    await db.insert(whatsappOnboardings).values([
      {
        whatsappAccountId: account!.id,
        wabaId: 'waba-1',
        phoneNumberId: 'pn-1',
        status: 'exchanged',
        defaultGroupId: sales,
      },
      {
        whatsappAccountId: account!.id,
        wabaId: 'waba-1',
        phoneNumberId: 'pn-2',
        status: 'connected',
        defaultGroupId: sales,
      },
    ]);

    const uses = await groupUses(sales);

    expect(uses.tickets).toBe(1);
    expect(uses.onboardings).toBe(1);
    expect(groupDeleteRefusal(uses)).toContain('1 ticket(s)');
    expect(groupDeleteRefusal(uses)).toContain('1 WhatsApp number(s) still being connected');
  });
});
