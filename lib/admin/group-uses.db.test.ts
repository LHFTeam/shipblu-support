import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  automationRules,
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
      onboardings: 0,
      automationRules: [],
      slaPolicies: [],
      skills: [],
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

    const uses = await groupUses(sales);

    expect(uses.channels).toEqual(['Sales mailbox']);
    expect(uses.forms).toEqual(['Pricing']);
    expect(uses.automationRules).toEqual(['Pricing to sales', 'Sales is urgent']);
    expect(uses.slaPolicies).toEqual(['Live sales']);
    expect(uses.skills).toEqual(['Arabic pricing']);
    expect(await deleteGroupIfUnused(sales)).toBe(
      'That group is still in use: the default for channel “Sales mailbox”; the default for form “Pricing”; ' +
        'named by automation rules “Pricing to sales”, “Sales is urgent”; named by SLA policy “Live sales”; ' +
        'required by skill “Arabic pricing”. Move them to another group first.',
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
      // Failed before its channel step: "Retry connection" can still start it,
      // and the channel it creates would start in this group.
      {
        whatsappAccountId: account!.id,
        wabaId: 'waba-1',
        phoneNumberId: 'pn-3',
        status: 'failed',
        error: 'Meta answered 500',
        defaultGroupId: sales,
      },
      {
        whatsappAccountId: account!.id,
        wabaId: 'waba-1',
        phoneNumberId: 'pn-7',
        status: 'failed',
        error: 'The worker stopped',
        defaultGroupId: sales,
      },
      // Past its channel step: the channel itself now holds the group.
      {
        whatsappAccountId: account!.id,
        wabaId: 'waba-1',
        phoneNumberId: 'pn-4',
        status: 'exchanged',
        channelId: '00000000-0000-4000-8000-000000000004',
        defaultGroupId: sales,
      },
      // Retired, and a retry refuses it.
      {
        whatsappAccountId: account!.id,
        wabaId: 'waba-1',
        phoneNumberId: 'pn-5',
        status: 'failed',
        error: 'superseded',
        defaultGroupId: sales,
      },
    ]);
    // Failed, and replaced by a newer attempt on the same number, which a retry
    // also refuses. The newer one names no group.
    await db.insert(whatsappOnboardings).values({
      whatsappAccountId: account!.id,
      wabaId: 'waba-1',
      phoneNumberId: 'pn-6',
      status: 'failed',
      error: 'Meta answered 500',
      defaultGroupId: sales,
      createdAt: new Date('2026-10-01T10:00:00Z'),
    });
    await db.insert(whatsappOnboardings).values({
      whatsappAccountId: account!.id,
      wabaId: 'waba-1',
      phoneNumberId: 'pn-6',
      status: 'connected',
      createdAt: new Date('2026-10-01T11:00:00Z'),
    });

    const uses = await groupUses(sales);

    expect(uses.tickets).toBe(1);
    // pn-1, pn-3 and pn-7. Counting `exchanged` alone said pn-1 and pn-4.
    expect(uses.onboardings).toBe(3);
    const refusal = await deleteGroupIfUnused(sales);
    expect(refusal).toContain('1 ticket(s)');
    expect(refusal).toContain('3 WhatsApp number(s) still being connected');
  });
});
