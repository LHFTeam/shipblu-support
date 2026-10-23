import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  channels,
  contacts,
  conversationShipments,
  conversations,
  groupMembers,
  groups,
  shipments,
  ticketStatuses,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { canSubscribeToConversation } from '@/lib/realtime/authorization';
import { conversationsForTrackingNumber } from '@/lib/shipments/queries';
import { withCleanDatabase } from '@/lib/testing/db';
import { handOverNumber } from '@/lib/whatsapp/number-owner';
import { loadConversation } from './console-guards';
import { getConversation } from './conversation';
import { inboxCounts, listInbox } from './inbox';
import { parseFilters } from './inbox-filters';
import { inboxGroupsFor, ownsANumber, scopeForAgent, seesTicket } from './visibility';

/**
 * `ticket.view.group`, end to end. The rule used to be spelled out in seven
 * places, and a group member must be admitted — and anybody else refused — by
 * every one of them, or a routed ticket is listed and then unopenable, or
 * openable and then unactionable. Each path is asked about the same four
 * tickets. The attachment route asks it too, and is driven beside the route
 * (`app/api/attachments/[id]/route.db.test.ts`), since `lib/` may not import
 * from `app/`.
 */

withCleanDatabase();

const TRACKING = 'SHIP12345';

let customerCare: string;
let merchantCare: string;
let member: SessionAgent;
let outsider: SessionAgent;
let admin: SessionAgent;
let tickets: Record<'careQueue' | 'merchantQueue' | 'mineInMerchant' | 'othersInCare', string>;
let numbers: Record<keyof typeof tickets, number>;

async function signedIn(
  role: 'admin' | 'agent',
  email: string,
  permissions: Record<string, boolean> = {},
): Promise<SessionAgent> {
  const [row] = await db
    .insert(agents)
    .values({ name: email, email, role, permissions })
    .returning();
  return {
    id: row!.id,
    email: row!.email,
    name: row!.name,
    role: row!.role,
    permissions,
    avatarUrl: null,
    avatarColor: row!.avatarColor,
    isAcceptingTickets: true,
    acceptingOffReason: null,
    sessionIdleForMs: 0,
  };
}

async function group(name: string): Promise<string> {
  const [row] = await db.insert(groups).values({ name }).returning({ id: groups.id });
  return row!.id;
}

async function ticket(groupId: string, assigneeAgentId: string | null) {
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [row] = await db
    .insert(conversations)
    .values({
      channel: 'instagram',
      statusId: open!.id,
      requesterContactId: contact!.id,
      groupId,
      assigneeAgentId,
    })
    .returning({ id: conversations.id, number: conversations.number });
  return row!;
}

beforeEach(async () => {
  customerCare = await group('Customer Care');
  merchantCare = await group('Merchant Care');
  member = await signedIn('agent', 'member@shipblu.test');
  outsider = await signedIn('agent', 'outsider@shipblu.test');
  admin = await signedIn('admin', 'admin@shipblu.test');
  await db.insert(groupMembers).values({ groupId: customerCare, agentId: member.id });

  const careQueue = await ticket(customerCare, null);
  const merchantQueue = await ticket(merchantCare, null);
  const mineInMerchant = await ticket(merchantCare, member.id);
  const othersInCare = await ticket(customerCare, outsider.id);
  tickets = {
    careQueue: careQueue.id,
    merchantQueue: merchantQueue.id,
    mineInMerchant: mineInMerchant.id,
    othersInCare: othersInCare.id,
  };
  numbers = {
    careQueue: careQueue.number,
    merchantQueue: merchantQueue.number,
    mineInMerchant: mineInMerchant.number,
    othersInCare: othersInCare.number,
  };
});

async function listed(agent: SessionAgent, params: Record<string, string> = {}) {
  const { rows } = await listInbox(agent, parseFilters(params));
  return rows.map((row) => row.id).sort();
}

describe('a group member', () => {
  it('lists their own tickets and every ticket in their groups, and nothing else', async () => {
    expect(await listed(member)).toEqual(
      [tickets.careQueue, tickets.mineInMerchant, tickets.othersInCare].sort(),
    );
  });

  it('narrows to their groups, to what is waiting there, and to one group', async () => {
    expect(await listed(member, { view: 'groups' })).toEqual(
      [tickets.careQueue, tickets.othersInCare].sort(),
    );
    expect(await listed(member, { view: 'unassigned' })).toEqual([tickets.careQueue]);
    // Naming a group they are not in narrows; it never widens to its queue.
    expect(await listed(member, { group: merchantCare })).toEqual([tickets.mineInMerchant]);
  });

  it('counts exactly what those lists hold', async () => {
    expect(await inboxCounts(member)).toEqual({ mine: 1, unassigned: 1, groups: 2, all: 3 });
  });

  it('opens, acts on and subscribes to a ticket in their group', async () => {
    expect(await getConversation(member, numbers.careQueue)).not.toBeNull();
    expect(await loadConversation(member, tickets.careQueue)).not.toBeNull();
    expect(await canSubscribeToConversation(member, tickets.careQueue)).toBe(true);
    expect(await seesTicket(member, tickets.careQueue)).toBe(true);
  });

  it('is refused a ticket in a group they are not in, by every path', async () => {
    expect(await getConversation(member, numbers.merchantQueue)).toBeNull();
    expect(await loadConversation(member, tickets.merchantQueue)).toBeNull();
    expect(await canSubscribeToConversation(member, tickets.merchantQueue)).toBe(false);
    expect(await seesTicket(member, tickets.merchantQueue)).toBe(false);
  });

  it('sees their group’s tickets on a shipment page, and not another group’s', async () => {
    const [shipment] = await db
      .insert(shipments)
      .values({ trackingNumber: TRACKING })
      .returning({ id: shipments.id });
    await db.insert(conversationShipments).values([
      { conversationId: tickets.careQueue, shipmentId: shipment!.id },
      { conversationId: tickets.merchantQueue, shipmentId: shipment!.id },
    ]);

    const found = await conversationsForTrackingNumber(TRACKING, scopeForAgent(member));
    expect(found.map((row) => row.id)).toEqual([tickets.careQueue]);
  });

  it('is offered their own groups as views', async () => {
    expect(await inboxGroupsFor(member)).toEqual([
      { id: customerCare, name: 'Customer Care', member: true },
    ]);
  });
});

describe('an agent in no group', () => {
  it('still sees only what is assigned to them', async () => {
    expect(await listed(outsider)).toEqual([tickets.othersInCare]);
    expect(await getConversation(outsider, numbers.careQueue)).toBeNull();
    expect(await inboxCounts(outsider)).toEqual({ mine: 1, unassigned: 0, groups: 0, all: 1 });
    expect(await inboxGroupsFor(outsider)).toEqual([]);
  });
});

describe('an agent whose group permission is taken away', () => {
  it('sees only their own tickets, though they are a member', async () => {
    const restricted = await signedIn('agent', 'restricted@shipblu.test', {
      'ticket.view.group': false,
    });
    await db.insert(groupMembers).values({ groupId: customerCare, agentId: restricted.id });

    expect(await listed(restricted)).toEqual([]);
    expect(await loadConversation(restricted, tickets.careQueue)).toBeNull();
    expect(await inboxGroupsFor(restricted)).toEqual([]);
  });
});

describe('an agent who sees every ticket', () => {
  it('is offered every group, marked by membership', async () => {
    await db.insert(groupMembers).values({ groupId: merchantCare, agentId: admin.id });

    expect(await listed(admin)).toHaveLength(4);
    // The baseline's Support group too: every group, not only the ones with tickets.
    expect(await inboxGroupsFor(admin)).toEqual([
      { id: customerCare, name: 'Customer Care', member: false },
      { id: merchantCare, name: 'Merchant Care', member: true },
      { id: expect.any(String), name: 'Support', member: false },
    ]);
    expect(await inboxCounts(admin)).toMatchObject({ groups: 2, all: 4 });
  });
});

/**
 * The owner of a WhatsApp number, as production has her: an agent-role user in
 * no group. A breach on her number's tickets counts against her whoever holds
 * them, so she must be able to open every one of them — by every path the
 * group member above is admitted by — and nothing on a number she does not own.
 */
describe('the owner of a WhatsApp number', () => {
  let owner: SessionAgent;
  let bob: SessionAgent;
  let hers: string;
  let ids: Record<
    'waiting' | 'withBob' | 'history' | 'answeredFor' | 'otherWaiting' | 'otherWithBob',
    string
  >;
  let numberOf: Record<keyof typeof ids, number>;

  async function number(name: string, ownerAgentId: string | null): Promise<string> {
    const [row] = await db
      .insert(channels)
      .values({ type: 'whatsapp', name, config: { phoneNumberId: name }, ownerAgentId })
      .returning({ id: channels.id });
    return row!.id;
  }

  async function onNumber(
    channelId: string,
    values: Partial<typeof conversations.$inferInsert> & { status?: string } = {},
  ) {
    const { status = 'Open', ...rest } = values;
    const [statusRow] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, status));
    const [contact] = await db.insert(contacts).values({ name: 'Merchant' }).returning();
    const [row] = await db
      .insert(conversations)
      .values({
        channel: 'whatsapp',
        channelId,
        statusId: statusRow!.id,
        requesterContactId: contact!.id,
        ...rest,
      })
      .returning({ id: conversations.id, number: conversations.number });
    return row!;
  }

  beforeEach(async () => {
    owner = await signedIn('agent', 'nayera@shipblu.test');
    bob = await signedIn('agent', 'bob@shipblu.test');
    hers = await number('Nayera Mohamed', owner.id);
    const team = await number('WhatsApp Support', null);

    const rows = {
      // Arrived on her number and nobody has taken it.
      waiting: await onNumber(hers, { accountableAgentId: owner.id }),
      // A supervisor gave the work to Bob; the breach is still hers.
      withBob: await onNumber(hers, { accountableAgentId: owner.id, assigneeAgentId: bob.id }),
      // Its copied history, which nobody is accountable for: hers by the number alone.
      history: await onNumber(hers, { sourceSystem: 'import', status: 'Resolved' }),
      // Resolved on another number while she owned it, which has since moved
      // on: accountable to her until its customer writes again.
      answeredFor: await onNumber(team, {
        accountableAgentId: owner.id,
        assigneeAgentId: bob.id,
        status: 'Resolved',
      }),
      otherWaiting: await onNumber(team),
      otherWithBob: await onNumber(team, { assigneeAgentId: bob.id }),
    };
    ids = Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row.id])) as typeof ids;
    numberOf = Object.fromEntries(
      Object.entries(rows).map(([key, row]) => [key, row.number]),
    ) as typeof numberOf;
  });

  it('lists every ticket on her number and every ticket she answers for, and nothing else', async () => {
    expect(await listed(owner)).toEqual([ids.waiting, ids.withBob].sort());
    expect(await listed(owner, { status: 'all' })).toEqual(
      [ids.waiting, ids.withBob, ids.history, ids.answeredFor].sort(),
    );
    // Unassigned is what has arrived on her number and nobody has taken.
    expect(await listed(owner, { view: 'unassigned' })).toEqual([ids.waiting]);
    expect(await listed(owner, { view: 'mine' })).toEqual([]);
    expect(await inboxCounts(owner)).toEqual({ mine: 0, unassigned: 1, groups: 0, all: 2 });
    expect(await ownsANumber(owner)).toBe(true);
  });

  it('opens, acts on and subscribes to one a colleague holds, and one she only answers for', async () => {
    for (const key of ['withBob', 'history', 'answeredFor'] as const) {
      expect(await getConversation(owner, numberOf[key])).not.toBeNull();
      expect(await loadConversation(owner, ids[key])).not.toBeNull();
      expect(await canSubscribeToConversation(owner, ids[key])).toBe(true);
      expect(await seesTicket(owner, ids[key])).toBe(true);
    }
  });

  it('is refused another number’s tickets by every path', async () => {
    for (const key of ['otherWaiting', 'otherWithBob'] as const) {
      expect(await getConversation(owner, numberOf[key])).toBeNull();
      expect(await loadConversation(owner, ids[key])).toBeNull();
      expect(await canSubscribeToConversation(owner, ids[key])).toBe(false);
      expect(await seesTicket(owner, ids[key])).toBe(false);
    }
  });

  it('sees her number’s tickets on a shipment page', async () => {
    const [shipment] = await db
      .insert(shipments)
      .values({ trackingNumber: TRACKING })
      .returning({ id: shipments.id });
    await db.insert(conversationShipments).values(
      [ids.waiting, ids.otherWaiting].map((conversationId) => ({
        conversationId,
        shipmentId: shipment!.id,
      })),
    );

    const found = await conversationsForTrackingNumber(TRACKING, scopeForAgent(owner));
    expect(found.map((row) => row.id)).toEqual([ids.waiting]);
  });

  it('widens nothing for the colleague working one of her tickets', async () => {
    expect(await listed(bob)).toEqual([ids.withBob, ids.otherWithBob].sort());
    expect(await ownsANumber(bob)).toBe(false);
  });

  // Read in the query on every request: the number's tickets go with the
  // number at the next page, and what she still answers for stays with her.
  it('loses the number’s open tickets when it is handed over, and keeps what she answers for', async () => {
    const handover = await handOverNumber({
      channelId: hers,
      toAgentId: bob.id,
      actor: { id: admin.id, label: 'Admin' },
    });
    expect(handover).toMatchObject({ ok: true, changed: true });

    expect(await listed(owner, { status: 'all' })).toEqual([ids.answeredFor]);
    expect(await seesTicket(owner, ids.withBob)).toBe(false);
    expect(await ownsANumber(owner)).toBe(false);
    expect(await listed(bob)).toEqual([ids.waiting, ids.withBob, ids.otherWithBob].sort());
  });
});
