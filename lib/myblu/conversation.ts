import { and, count, eq, gt, isNull, notInArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, messages } from '@/db/schema';
import { preview } from '@/lib/html/sanitize';
import {
  appendReply,
  createTicket,
  getTicket,
  listTickets,
  subjectFrom,
  type PortalTicketDetail,
} from '@/lib/portal/tickets';
import { attachShipment, upsertShipmentStub } from '@/lib/shipments/links';
import { normaliseTrackingNumber } from '@/lib/shipments/format';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';

/**
 * The app's view of its user's tickets.
 *
 * Deliberately thin. `lib/portal/tickets.ts` already answers every question
 * here for a signed-in customer, and it answers them with the properties that
 * matter: every query is scoped by the contact id rather than by a ticket id
 * the caller supplied, a ticket is addressed by number **paired with the
 * requester in the same `where`** rather than looked up and checked afterwards,
 * and private notes are excluded in the query rather than filtered in the
 * renderer — so a note is not in the payload to leak.
 *
 * Writing a second copy of that for a second client is how one of those
 * properties ends up holding in one place and not the other. What this module
 * adds is the two things genuinely specific to the app: the parcel a ticket was
 * opened about, and a cursor cheap enough to poll.
 */

const MAX_BODY = 5_000;

export type MobileMessage = {
  id: string;
  from: 'customer' | 'agent';
  authorName: string | null;
  body: string;
  createdAt: string;
};

export type MobileConversation = {
  number: number;
  subject: string | null;
  status: string | null;
  statusCategory: string;
  lastMessageAt: string;
  createdAt: string;
};

export type MobileThread = MobileConversation & {
  messages: MobileMessage[];
  canReply: boolean;
};

export async function listConversations(contactId: string): Promise<MobileConversation[]> {
  const rows = await listTickets(contactId);
  return rows.map(summary);
}

/**
 * One thread, optionally only what is new.
 *
 * `since` is **exclusive**, and that is the whole reason it is an explicit
 * parameter rather than a filter the app applies to a full list. The app polls
 * this with the timestamp of the last message it holds; an inclusive comparison
 * would hand that message back on every poll, and a client appending what it
 * receives would duplicate the conversation one message at a time.
 */
export async function getConversation(
  contactId: string,
  number: number,
  since?: Date | null,
): Promise<MobileThread | null> {
  const ticket = await getTicket(contactId, number);
  if (!ticket) return null;

  return {
    ...summary(ticket),
    canReply: ticket.canReply,
    messages: messagesSince(ticket.messages, since),
  };
}

/**
 * The messages a polling client has not already seen.
 *
 * Pure and exported so the boundary has a test. `since` is **exclusive**: the
 * app sends the timestamp of the last message it holds, so `>=` would hand that
 * message back on every poll and a client appending what it receives would
 * duplicate the conversation one message at a time. The comparison is on
 * `getTime()` rather than on the `Date` objects, because `>` on two `Date`s
 * compares object identity for equal instants in some engines and is the kind
 * of thing that works until it does not.
 */
export function messagesSince(
  rows: readonly {
    id: string;
    from: 'customer' | 'agent';
    authorName: string | null;
    body: string;
    createdAt: Date;
  }[],
  since?: Date | null,
): MobileMessage[] {
  return rows
    .filter((message) => !since || message.createdAt.getTime() > since.getTime())
    .map((message) => ({
      id: message.id,
      from: message.from,
      authorName: message.authorName,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    }));
}

export type OpenedConversation = { number: number; conversationId: string };

/**
 * Opens a ticket from the app.
 *
 * The tracking number is attached as a **conversation** link with
 * `link_source: 'platform'`, the same standing the widget gives an account a
 * host page names — and for the same reason its comment gives: the link says
 * the parcel *came up on this ticket*, not that this person owns it. That
 * remains true whether or not the platform confirmed who is calling, which is
 * why it is not gated on `verified`.
 *
 * What is deliberately never written from here is `contact_shipping_accounts`.
 * That table asserts who may speak for a *merchant* account, and a myBlu user
 * is a recipient — somebody the merchant sent a parcel to.
 */
export async function openConversation(
  contactId: string,
  input: { body: string; subject?: string | null; trackingNumber?: string | null },
): Promise<OpenedConversation> {
  const body = input.body.trim().slice(0, MAX_BODY);

  const created = await createTicket(contactId, {
    channel: 'mobile',
    // The app may name the screen the customer came from; otherwise the first
    // message is the most useful thing to show in a ticket list, which is the
    // same fallback web chat makes.
    subject: (input.subject ?? '').trim().slice(0, 200) || subjectFrom(body) || 'myBlu support',
    body,
  });

  const tracking = normaliseTrackingNumber(input.trackingNumber ?? '');
  if (tracking) {
    const shipmentId = await upsertShipmentStub(tracking);
    const attached = await attachShipment({
      conversationId: created.conversationId,
      shipmentId,
      linkSource: 'platform',
    });

    if (attached) {
      await db.insert(conversationEvents).values({
        conversationId: created.conversationId,
        type: 'shipment_linked',
        actorLabel: 'myblu',
        data: { trackingNumber: tracking },
      });
    }
  }

  return { number: created.number, conversationId: created.conversationId };
}

export async function reply(
  contactId: string,
  number: number,
  body: string,
): Promise<{ ok: boolean }> {
  return appendReply(contactId, number, body.trim().slice(0, MAX_BODY));
}

/**
 * How many of this customer's tickets have an agent reply they have not opened.
 *
 * Approximated as "the last message is ours", which is what the app needs for a
 * badge and is one indexed read rather than a per-ticket scan. Read receipts
 * would be a column and a write path for a number nobody reasons from.
 */
export async function unreadCount(contactId: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(conversations)
    .where(
      and(
        eq(conversations.requesterContactId, contactId),
        isNull(conversations.deletedAt),
        isNull(conversations.mergedIntoId),
        eq(conversations.isSpam, false),
        notInArray(conversations.channel, readOnlyChannels()),
        gt(conversations.lastAgentMessageAt, conversations.lastCustomerMessageAt),
      ),
    );

  return rows[0]?.n ?? 0;
}

/**
 * The most recent message on a thread, for the poll's `ETag`.
 *
 * Separate from `getConversation` so the cheap question can be asked cheaply:
 * the app polls every few seconds while a thread is open, and the answer is
 * almost always "nothing changed".
 */
export async function threadVersion(contactId: string, number: number): Promise<string | null> {
  const rows = await db
    .select({ id: conversations.id, lastMessageAt: conversations.lastMessageAt })
    .from(conversations)
    .where(
      and(
        eq(conversations.number, number),
        eq(conversations.requesterContactId, contactId),
        isNull(conversations.deletedAt),
        eq(conversations.isSpam, false),
        notInArray(conversations.channel, readOnlyChannels()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const latest = await db
    .select({ n: count() })
    .from(messages)
    .where(and(eq(messages.conversationId, row.id), eq(messages.kind, 'reply')));

  // The count as well as the instant: two messages written inside the same
  // millisecond would otherwise share a version, and the second would never
  // reach a client that had already seen the first.
  return `"${row.lastMessageAt.getTime()}-${latest[0]?.n ?? 0}"`;
}

function summary(ticket: {
  number: number;
  subject: string | null;
  statusLabel: string | null;
  statusCategory: string;
  lastMessageAt: Date;
  createdAt: Date;
}): MobileConversation {
  return {
    number: ticket.number,
    subject: ticket.subject ? preview(ticket.subject, 120) : null,
    // The customer label only, never the status's own name — "Escalated to ops
    // — tier 2" is for the team. `listTickets` has already applied that rule;
    // null here means the app falls back to a word for the category in the
    // reader's language.
    status: ticket.statusLabel,
    statusCategory: ticket.statusCategory,
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    createdAt: ticket.createdAt.toISOString(),
  };
}

export type { PortalTicketDetail };
