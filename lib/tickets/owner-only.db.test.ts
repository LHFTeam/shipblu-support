import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  automationRules,
  channels,
  contacts,
  conversationEvents,
  conversations,
  groupMembers,
  groups,
  ticketStatuses,
} from '@/db/schema';
import { assignConversation } from '@/lib/assignment';
import { runAutomations } from '@/lib/automations';
import { withCleanDatabase } from '@/lib/testing/db';
import { hasCoexistenceRecord, parseCoexistence } from '@/lib/whatsapp/coexistence';
import { listAssignableAgents } from './lookups';
import {
  agentsWhoSeeEveryTicket,
  hiddenFromHolder,
  notOnCoexistenceNumber,
  onCoexistenceNumber,
  ownerOnlyNumber,
} from './owner-only';

/**
 * Who may be left holding a coexistence number's ticket, asked of each writer
 * that hands tickets out. `visibility.db.test.ts` asks who may read one; a
 * ticket held by somebody it is hidden from is the two rules disagreeing.
 */

withCleanDatabase();

let people = 0;

async function agent(name: string, values: Partial<typeof agents.$inferInsert> = {}) {
  people += 1;
  const [row] = await db
    .insert(agents)
    .values({
      name,
      email: `agent${people}@shipblu.test`,
      presence: 'online',
      lastSeenAt: new Date(),
      ...values,
    })
    .returning({ id: agents.id });
  return row!.id;
}

const COEXISTENCE = { onboardedAt: '2026-10-01T09:00:00.000Z', wabaId: '1' };

async function number(config: Record<string, unknown>, ownerAgentId: string | null = null) {
  people += 1;
  const [row] = await db
    .insert(channels)
    .values({
      type: 'whatsapp',
      name: `Number ${people}`,
      ownerAgentId,
      config: { phoneNumberId: `pn-${people}`, ...config },
    })
    .returning({ id: channels.id });
  return row!.id;
}

const phone = (ownerAgentId: string | null = null) =>
  number({ coexistence: COEXISTENCE }, ownerAgentId);

/** A group that assigns round robin at any hour, with these members. */
async function group(members: string[]) {
  const [row] = await db
    .insert(groups)
    .values({
      name: 'Customer Care',
      assignmentStrategy: 'round_robin',
      assignWithinHoursOnly: false,
    })
    .returning({ id: groups.id });
  await db.insert(groupMembers).values(members.map((agentId) => ({ groupId: row!.id, agentId })));
  return row!.id;
}

async function ticket(
  channelId: string | null,
  values: Partial<typeof conversations.$inferInsert> = {},
) {
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .insert(conversations)
    .values({
      channel: channelId ? 'whatsapp' : 'email',
      channelId,
      statusId: open!.id,
      requesterContactId: contact!.id,
      ...values,
    })
    .returning({ id: conversations.id });
  return row!.id;
}

async function assigneeOf(id: string) {
  const [row] = await db
    .select({ assignee: conversations.assigneeAgentId })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row!.assignee;
}

describe('which number is a coexistence number', () => {
  // The predicate and `parseCoexistence` agree on every record the onboarding
  // writes. They part on one written by hand, on purpose, and on the side
  // that hides: any object under `coexistence` counts.
  it('agrees with parseCoexistence on a real record, and hides on a broken one', async () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{}, false],
      [{ coexistence: null }, false],
      [{ coexistence: 'yes' }, false],
      [{ coexistence: COEXISTENCE }, true],
      [{ coexistence: { ...COEXISTENCE, disconnected: { at: '2026-10-02T09:00:00.000Z' } } }, true],
      [{ coexistence: {} }, true],
    ];
    for (const [config, expected] of cases) {
      const channelId = await number(config);
      const id = await ticket(channelId);
      const [row] = await db
        .select({ on: onCoexistenceNumber(), off: notOnCoexistenceNumber() })
        .from(conversations)
        .where(eq(conversations.id, id));
      expect([config, row]).toEqual([config, { on: expected, off: !expected }]);
      expect((await ownerOnlyNumber(db, channelId)) !== null).toBe(expected);
      // The ticket page's twin, so a page never calls a hidden ticket a team number's.
      expect(hasCoexistenceRecord(config)).toBe(expected);
      if (parseCoexistence(config)) expect(expected).toBe(true);
    }
  });

  it('answers for a ticket on no number at all, and for the bot', async () => {
    await phone();
    const email = await ticket(null);
    const [bot] = await db
      .insert(channels)
      .values({ type: 'whatsapp_bot', name: 'Bot', config: { coexistence: COEXISTENCE } })
      .returning({ id: channels.id });
    const onBot = await ticket(bot!.id, { channel: 'whatsapp_bot' });

    for (const id of [email, onBot]) {
      const [row] = await db
        .select({ on: onCoexistenceNumber(), off: notOnCoexistenceNumber() })
        .from(conversations)
        .where(eq(conversations.id, id));
      // `on` is null for no number, never true; `off` is what a `where` reads.
      expect(row!.on === true).toBe(false);
      expect(row!.off).toBe(true);
    }
  });
});

describe('who sees every ticket', () => {
  it('follows the role and the agent’s own overrides, and leaves out the deactivated', async () => {
    const plain = await agent('Bob Agent');
    const supervisor = await agent('Sara Supervisor', { role: 'supervisor' });
    const admin = await agent('Mona Admin', { role: 'admin' });
    const granted = await agent('Gamal Agent', { permissions: { 'ticket.view.all': true } });
    const revoked = await agent('Omar Supervisor', {
      role: 'supervisor',
      permissions: { 'ticket.view.all': false },
    });
    const gone = await agent('Left Admin', { role: 'admin', isActive: false });

    const all = await agentsWhoSeeEveryTicket(db);
    expect([...all].sort()).toEqual([supervisor, admin, granted].sort());
    expect(all.has(plain) || all.has(revoked) || all.has(gone)).toBe(false);
  });
});

describe('the rota', () => {
  let lina: string;
  let care: string;

  beforeEach(async () => {
    lina = await agent('Lina Care');
    care = await group([lina]);
  });

  it('gives a coexistence number’s ticket to nobody when the number has no owner', async () => {
    const id = await ticket(await phone(), { groupId: care });

    expect(await assignConversation(id)).toEqual({
      assignedTo: null,
      reason: 'owner_only',
      movedGroup: false,
    });
    expect(await assigneeOf(id)).toBeNull();
    // The sweep asks again every pass: a line each time would bury the ticket.
    expect(
      await db.select().from(conversationEvents).where(eq(conversationEvents.conversationId, id)),
    ).toEqual([]);

    // The same ticket on a number answered through the console is hers.
    const plain = await ticket(await number({}), { groupId: care });
    expect(await assignConversation(plain)).toMatchObject({ assignedTo: lina });
  });

  it('nor when its owner is deactivated, whom the number counts as nobody', async () => {
    const left = await agent('Nayera Mohamed', { isActive: false });
    const id = await ticket(await phone(left), { groupId: care });

    expect(await assignConversation(id)).toMatchObject({ assignedTo: null, reason: 'owner_only' });
  });

  // A ticket that arrived while its number's owner was deactivated is
  // accountable to nobody, and nothing realigns an open ticket when they are
  // reactivated. On a plain number the rota took it; here it may not, so the
  // ticket is made the owner's instead of waiting unassigned for good.
  it('gives one accountable to nobody to the number’s active owner, and makes it theirs', async () => {
    const nayera = await agent('Nayera Mohamed', { presence: 'offline' });
    const channelId = await phone(nayera);
    const id = await ticket(channelId, { groupId: care });

    expect(await assignConversation(id)).toEqual({
      assignedTo: nayera,
      reason: null,
      movedGroup: false,
    });
    const [row] = await db
      .select({
        assignee: conversations.assigneeAgentId,
        accountable: conversations.accountableAgentId,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row).toEqual({ assignee: nayera, accountable: nayera });
    const events = await db
      .select({ type: conversationEvents.type, data: conversationEvents.data })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, id));
    expect(events.map((e) => [e.type, e.data.reason]).sort()).toEqual([
      ['accountable_changed', 'owner_returned'],
      ['assigned', 'number_owner'],
    ]);

    // Not a ticket nobody may work: resolved, it is left as it is.
    const [resolved] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Resolved'));
    const done = await ticket(channelId, { groupId: care, statusId: resolved!.id });
    expect(await assignConversation(done)).toMatchObject({ assignedTo: null });
    expect(await assigneeOf(done)).toBeNull();
  });

  // The number's word outranks the ticket's: one adopted onto the row, or
  // stamped before a handover it missed, answers to somebody who is not the
  // owner, and handing it back to them would give it to somebody it is
  // hidden from.
  it('gives one accountable to somebody else to the number’s owner, not to them', async () => {
    const nayera = await agent('Nayera Mohamed');
    const id = await ticket(await phone(nayera), { groupId: care, accountableAgentId: lina });

    expect(await assignConversation(id)).toMatchObject({ assignedTo: nayera, reason: null });
    const [row] = await db
      .select({
        assignee: conversations.assigneeAgentId,
        accountable: conversations.accountableAgentId,
      })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(row).toEqual({ assignee: nayera, accountable: nayera });
  });

  it('still hands one back to an active owner', async () => {
    const nayera = await agent('Nayera Mohamed', { presence: 'offline' });
    const id = await ticket(await phone(nayera), { groupId: care, accountableAgentId: nayera });

    expect(await assignConversation(id)).toMatchObject({ assignedTo: nayera, reason: null });
  });
});

describe('a rule that assigns an agent', () => {
  async function assignTo(agentId: string) {
    await db.delete(automationRules);
    await db.insert(automationRules).values({
      name: 'Give it to them',
      trigger: 'on_update',
      conditions: {},
      actions: [{ type: 'assign_agent', agentId }],
      position: 0,
    });
  }

  it('is not applied to a coexistence number’s ticket hidden from that agent', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nayera = await agent('Nayera Mohamed');
    const bob = await agent('Bob Agent');
    const sara = await agent('Sara Supervisor', { role: 'supervisor' });
    const onPhone = await ticket(await phone(nayera), { assigneeAgentId: nayera });
    const plain = await ticket(await number({}, nayera), { assigneeAgentId: nayera });

    await assignTo(bob);
    await runAutomations('on_update', onPhone);
    await runAutomations('on_update', plain);
    expect(await assigneeOf(onPhone)).toBe(nayera);
    expect(await assigneeOf(plain)).toBe(bob);
    expect(warned.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('to an agent it is hidden from'),
    ]);
    warned.mockRestore();

    // A supervisor sees every ticket, so the rule may name her.
    await assignTo(sara);
    await runAutomations('on_update', onPhone);
    expect(await assigneeOf(onPhone)).toBe(sara);
  });
});

describe('hiddenFromHolder', () => {
  it('reads the owner a caller names over the row’s, for one who counts as nobody', async () => {
    const nayera = await agent('Nayera Mohamed');
    const channelId = await phone(nayera);

    expect(await hiddenFromHolder(db, channelId, nayera)).toBe(false);
    expect(await hiddenFromHolder(db, channelId, nayera, { ownerId: null })).toBe(true);
    expect(await hiddenFromHolder(db, channelId, nayera, { lock: true })).toBe(false);
    expect(await hiddenFromHolder(db, null, nayera, { ownerId: null })).toBe(false);
  });

  // Somebody who cannot sign in sees nothing, whatever their role: the answer
  // a handover gives (`agentsWhoSeeEveryTicket`), so a reopen gives it too.
  it('counts a deactivated agent as hidden from, a supervisor and the owner included', async () => {
    const leftOwner = await agent('Nayera Mohamed', { isActive: false });
    const leftSupervisor = await agent('Sara Supervisor', { role: 'supervisor', isActive: false });
    const channelId = await phone(leftOwner);

    expect(await hiddenFromHolder(db, channelId, leftSupervisor)).toBe(true);
    expect(await hiddenFromHolder(db, channelId, leftOwner)).toBe(true);
    // Off a coexistence number the rule has nothing to say about anybody.
    expect(await hiddenFromHolder(db, await number({}), leftSupervisor)).toBe(false);
  });
});

describe('the Assignee picker', () => {
  it('offers only who can see a coexistence number’s ticket, and whoever holds it', async () => {
    const nayera = await agent('Nayera Mohamed');
    const bob = await agent('Bob Agent');
    const carl = await agent('Carl Agent');
    const sara = await agent('Sara Supervisor', { role: 'supervisor' });
    await agent('Left Agent', { isActive: false });
    const channelId = await phone(nayera);

    const names = async (ticket: { channelId: string | null; assigneeAgentId: string | null }) =>
      (await listAssignableAgents(ticket)).map((row) => row.id).sort();

    expect(await names({ channelId, assigneeAgentId: null })).toEqual([nayera, sara].sort());
    // Bob holds it from before the rule: shown, so the select does not read
    // "Unassigned", though the action would refuse him again.
    expect(await names({ channelId, assigneeAgentId: bob })).toEqual([nayera, bob, sara].sort());
    expect(await names({ channelId: null, assigneeAgentId: null })).toEqual(
      [nayera, bob, carl, sara].sort(),
    );
    expect(await names({ channelId: await number({}), assigneeAgentId: null })).toHaveLength(4);
  });
});
