import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agentSkills,
  agents,
  cannedResponses,
  contacts,
  conversations,
  groupMembers,
  groups,
  locations,
  shipmentPhrases,
  skills,
  ticketFields,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import {
  listActiveAgents,
  listCannedResponses,
  listGroupsForAdmin,
  listSkillHolders,
  listLocations,
  listSavedPhrases,
  listTicketFields,
  listTicketStatuses,
} from './settings';

/**
 * The admin settings pages' lists: every row, in the order the page shows
 * them, inactive ones included where the table has the flag. An admin edits a
 * retired row from these same pages, so a list that dropped them would leave
 * it uneditable.
 */

withCleanDatabase();

describe('the admin settings lists', () => {
  it('lists canned responses by folder, then title', async () => {
    await db.insert(cannedResponses).values([
      { title: 'Refund', folder: 'Billing' },
      { title: 'Address change', folder: 'Delivery' },
      { title: 'Apology', folder: 'Billing' },
    ]);

    const rows = await listCannedResponses();

    expect(rows.map((row) => row.title)).toEqual(['Apology', 'Refund', 'Address change']);
  });

  it('lists ticket fields by position, then label', async () => {
    await db.insert(ticketFields).values([
      { key: 'warehouse', label: 'Warehouse', type: 'text', position: 2 },
      { key: 'reason', label: 'Reason', type: 'text', position: 1, isActive: false },
      { key: 'area', label: 'Area', type: 'text', position: 1 },
    ]);

    expect((await listTicketFields()).map((row) => row.key)).toEqual([
      'area',
      'reason',
      'warehouse',
    ]);
  });

  it('lists locations by code, with the five columns the page reads', async () => {
    await db.insert(locations).values([
      { name: 'Giza hub', code: 'GIZ', email: 'giza@shipblu.test' },
      { name: 'Alexandria', code: 'ALX', email: 'alex@shipblu.test', isActive: false },
    ]);

    const rows = await listLocations();

    expect(rows.map((row) => row.code)).toEqual(['ALX', 'GIZ']);
    expect(Object.keys(rows[0]!).sort()).toEqual(['code', 'email', 'id', 'isActive', 'name']);
  });

  it('lists the seeded statuses in their position order', async () => {
    expect((await listTicketStatuses()).map((row) => row.name)).toEqual([
      'Open',
      'Pending',
      'Resolved',
      'Closed',
    ]);
  });

  it('lists only the phrases an admin saved', async () => {
    expect(await listSavedPhrases()).toEqual([]);
    await db.insert(shipmentPhrases).values({ key: 'delivered', ar: 'تم التسليم' });

    expect(await listSavedPhrases()).toEqual([{ key: 'delivered', ar: 'تم التسليم' }]);
  });

  it('lists active agents only, by name', async () => {
    await db.insert(agents).values([
      { name: 'Zeina', email: 'zeina@shipblu.test' },
      { name: 'Adel', email: 'adel@shipblu.test' },
      { name: 'Former', email: 'former@shipblu.test', isActive: false },
    ]);

    expect((await listActiveAgents()).map((row) => row.name)).toEqual(['Adel', 'Zeina']);
  });

  // The two counts are raw subqueries correlated on the outer group, and the
  // member count's correlation is the unqualified shape its neighbour's comment
  // warns about. This is what holds both to the group they are read for.
  it("counts each group's members and its answerable tickets, and no one else's", async () => {
    const [support] = await db.select({ id: groups.id }).from(groups);
    const [returns] = await db
      .insert(groups)
      .values({ name: 'Returns' })
      .returning({ id: groups.id });
    const [agent] = await db
      .insert(agents)
      .values({ name: 'Omar', email: 'omar@shipblu.test' })
      .returning({ id: agents.id });
    await db.insert(groupMembers).values({ groupId: returns!.id, agentId: agent!.id });

    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Amira' })
      .returning({ id: contacts.id });
    const ticket = (channel: 'email' | 'whatsapp_bot', groupId: string) => ({
      requesterContactId: contact!.id,
      statusId: open!.id,
      channel,
      groupId,
    });
    await db
      .insert(conversations)
      .values([
        ticket('email', returns!.id),
        ticket('email', returns!.id),
        ticket('whatsapp_bot', returns!.id),
        ticket('email', support!.id),
      ]);

    const rows = await listGroupsForAdmin();

    expect(rows.map((row) => [row.name, row.members, row.tickets])).toEqual([
      ['Returns', 1, 2],
      ['Support', 0, 1],
    ]);
  });

  it('asks nothing for no skills, and names each holder of the ones asked about', async () => {
    expect(await listSkillHolders([])).toEqual([]);

    const [arabic] = await db
      .insert(skills)
      .values({ name: 'Arabic' })
      .returning({ id: skills.id });
    const [agent] = await db
      .insert(agents)
      .values({ name: 'Omar', email: 'omar@shipblu.test' })
      .returning({ id: agents.id });
    await db.insert(agentSkills).values({ skillId: arabic!.id, agentId: agent!.id });

    expect(await listSkillHolders([arabic!.id])).toEqual([
      { skillId: arabic!.id, agentId: agent!.id },
    ]);
  });
});
