import { and, desc, eq, ilike, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  contactShippingAccounts,
  contacts,
  conversationShipments,
  conversationShippingAccounts,
  conversations,
  companies,
  shipments,
  shippingAccounts,
  ticketStatuses,
} from '@/db/schema';
import type { ConversationChannel } from '@/lib/tickets/channel-policy';
import { normaliseSbid, normaliseTrackingNumber } from './format';
import { deriveRequesterRole, type RequesterRole } from './roles';
import { returnsForShipments } from './lookup';

/**
 * Reading shipments, shipping accounts and what is attached to them.
 *
 * Note what these functions do not take: a `SessionAgent`. That is the seam the
 * eventual platform endpoint sits on — the console wraps them with the agent's
 * permissions, and the endpoint will wrap them with the API key's. Baking
 * `can()` in would force that endpoint to invent a fake agent, which is how an
 * API ends up with an account that reaches further than any human.
 *
 * `ReadScope` is passed in instead, and both callers are expected to exclude the
 * restricted channels: a conversation nobody on the team works is not something
 * to hand to an external caller either.
 */

export type ReadScope = {
  excludeChannels?: readonly ConversationChannel[];
  onlyAssigneeAgentId?: string;
  includeClosed?: boolean;
  limit?: number;
};

export type ConversationSummary = {
  id: string;
  number: number;
  subject: string | null;
  channel: string;
  priority: string;
  statusName: string;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  requesterName: string | null;
  requesterHandle: string | null;
  assigneeName: string | null;
  tags: string[];
  createdAt: Date;
  lastMessageAt: Date;
};

export type LinkedShipment = {
  shipmentId: string;
  trackingNumber: string;
  statusLabel: string | null;
  /** When the platform says the status changed — not when we last asked. */
  statusAt: Date | null;
  /**
   * Which step of the journey *back* this parcel is on, or null if it is not
   * going back.
   *
   * Carried here because `status_label` cannot answer it: the platform leaves
   * the status reading `delivery_attempted` for the whole of a return, so a
   * sidebar drawing the label alone tells an agent on a call that a parcel is
   * still coming (`docs/PROJECT-STATE.md` §6.40).
   */
  returnStep: number | null;
  /** The freshest estimated delivery date, as a `YYYY-MM-DD` string. */
  currentEstimatedDate: string | null;
  /**
   * When we last asked, which is a different question and the one an agent on a
   * call needs answered. "Delivered, as of a status we read four days ago" is
   * the sentence a refresh button exists for.
   */
  lastSyncedAt: Date | null;
  syncState: 'stub' | 'synced' | 'not_found';
  sbid: string | null;
  requesterRole: RequesterRole;
  linkSource: 'detected' | 'manual' | 'platform';
  linkedAt: Date;
};

export type LinkedShippingAccount = {
  shippingAccountId: string;
  sbid: string;
  name: string | null;
  linkSource: 'detected' | 'manual' | 'platform';
  linkedAt: Date;
};

export type ShipmentDetail = {
  id: string;
  trackingNumber: string;
  statusLabel: string | null;
  statusAt: Date | null;
  syncState: 'stub' | 'synced' | 'not_found';
  lastSyncedAt: Date | null;
  shippingAccountId: string | null;
  sbid: string | null;
  shipper: { id: string; name: string | null; handle: string | null } | null;
  recipient: { id: string; name: string | null; handle: string | null } | null;
};

export type ShippingAccountDetail = {
  id: string;
  sbid: string;
  name: string | null;
  syncState: 'stub' | 'synced' | 'not_found';
  companyId: string | null;
  companyName: string | null;
};

export type ContactSummary = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  isShipper: boolean;
  isRecipient: boolean;
  linkSource: 'detected' | 'manual' | 'platform';
};

const SUMMARY_LIMIT = 50;

/** The shared select list, so every list of conversations reads the same. */
function summarySelect() {
  return {
    id: conversations.id,
    number: conversations.number,
    subject: conversations.subject,
    channel: conversations.channel,
    priority: conversations.priority,
    statusName: ticketStatuses.name,
    statusCategory: ticketStatuses.category,
    requesterName: contacts.name,
    requesterEmail: contacts.primaryEmail,
    requesterPhone: contacts.primaryPhone,
    assigneeName: agents.name,
    tags: conversations.tags,
    createdAt: conversations.createdAt,
    lastMessageAt: conversations.lastMessageAt,
  };
}

function scopeClauses(scope: ReadScope): SQL[] {
  const where: SQL[] = [isNull(conversations.deletedAt), isNull(conversations.mergedIntoId)];

  if (scope.excludeChannels?.length) {
    where.push(notInArray(conversations.channel, [...scope.excludeChannels]));
  }
  if (scope.onlyAssigneeAgentId) {
    where.push(eq(conversations.assigneeAgentId, scope.onlyAssigneeAgentId));
  }
  if (!scope.includeClosed) {
    where.push(notInArray(ticketStatuses.category, ['closed']));
  }

  return where;
}

function toSummary(row: {
  id: string;
  number: number;
  subject: string | null;
  channel: string;
  priority: string;
  statusName: string;
  statusCategory: 'open' | 'pending' | 'resolved' | 'closed';
  requesterName: string | null;
  requesterEmail: string | null;
  requesterPhone: string | null;
  assigneeName: string | null;
  tags: string[];
  createdAt: Date;
  lastMessageAt: Date;
}): ConversationSummary {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    channel: row.channel,
    priority: row.priority,
    statusName: row.statusName,
    statusCategory: row.statusCategory,
    requesterName: row.requesterName,
    requesterHandle: row.requesterEmail ?? row.requesterPhone,
    assigneeName: row.assigneeName,
    tags: row.tags,
    createdAt: row.createdAt,
    lastMessageAt: row.lastMessageAt,
  };
}

/**
 * Every conversation attached to a tracking number.
 *
 * The future platform endpoint's whole job. One probe of the unique index on
 * `shipments.tracking_number`, then a range scan of
 * `conversation_shipments_shipment_idx` — no sequential scan on either side.
 */
export async function conversationsForTrackingNumber(
  trackingNumber: string,
  scope: ReadScope = {},
): Promise<ConversationSummary[]> {
  const canonical = normaliseTrackingNumber(trackingNumber);
  if (!canonical) return [];

  const rows = await db
    .select(summarySelect())
    .from(conversationShipments)
    .innerJoin(shipments, eq(shipments.id, conversationShipments.shipmentId))
    .innerJoin(conversations, eq(conversations.id, conversationShipments.conversationId))
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .where(and(eq(shipments.trackingNumber, canonical), ...scopeClauses(scope)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(scope.limit ?? SUMMARY_LIMIT);

  return rows.map(toSummary);
}

/**
 * Every conversation for a shipping account, by either route.
 *
 * Two branches, and the second is the one that matters. A merchant's tickets
 * usually never quote their own account number — they just say "my parcels are
 * stuck". Those are found because the requester belongs to the account.
 */
export async function conversationsForSbid(
  sbid: string,
  scope: ReadScope = {},
): Promise<ConversationSummary[]> {
  const canonical = normaliseSbid(sbid);
  if (!canonical) return [];

  const rows = await db
    .select(summarySelect())
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .where(and(sbidMatches(canonical), ...scopeClauses(scope)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(scope.limit ?? SUMMARY_LIMIT);

  return rows.map(toSummary);
}

/**
 * The SBID predicate, shared with the inbox search.
 *
 * Two ways a ticket belongs to an account: it names the account, or its
 * requester is somebody who can speak for it. The second is the branch that
 * earns its place — a merchant's tickets almost never quote their own account
 * number, they just say "my parcels are stuck".
 *
 * Written as one `IN` over a `UNION` rather than the obvious `OR` of two `IN`s,
 * and the difference is not stylistic. An `OR` across two different columns of
 * `conversations` cannot be answered from an index: the planner hashes both
 * subqueries and sequentially scans the whole conversation table to apply them.
 * Measured on 50k conversations that was 9.7 ms and 50,001 rows discarded by the
 * filter; the `UNION` collapses to a single id set and probes the primary key,
 * for 0.37 ms and no scan. The gap grows with the archive, which is the wrong
 * direction for the query behind a search box.
 */
export function sbidMatches(canonicalSbid: string): SQL {
  return sql`${conversations.id} IN (
    SELECT ca.conversation_id
    FROM ${conversationShippingAccounts} ca
    JOIN ${shippingAccounts} a ON a.id = ca.shipping_account_id
    WHERE a.sbid = ${canonicalSbid}

    UNION

    SELECT sc.id
    FROM ${conversations} sc
    WHERE sc.requester_contact_id IN (
      SELECT csa.contact_id
      FROM ${contactShippingAccounts} csa
      JOIN ${shippingAccounts} a2 ON a2.id = csa.shipping_account_id
      WHERE a2.sbid = ${canonicalSbid}
    )
  )`;
}

/** The tracking-number predicate, shared with the inbox search. */
export function trackingMatches(canonicalTrackingNumber: string): SQL {
  return sql`${conversations.id} IN (
    SELECT ${conversationShipments.conversationId}
    FROM ${conversationShipments}
    JOIN ${shipments} ON ${shipments.id} = ${conversationShipments.shipmentId}
    WHERE ${shipments.trackingNumber} = ${canonicalTrackingNumber}
  )`;
}

export async function getShipmentByTrackingNumber(
  trackingNumber: string,
): Promise<ShipmentDetail | null> {
  const canonical = normaliseTrackingNumber(trackingNumber);
  if (!canonical) return null;

  const rows = await db
    .select({
      shipment: shipments,
      sbid: shippingAccounts.sbid,
    })
    .from(shipments)
    .leftJoin(shippingAccounts, eq(shippingAccounts.id, shipments.shippingAccountId))
    .where(eq(shipments.trackingNumber, canonical))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const partyIds = [row.shipment.shipperContactId, row.shipment.recipientContactId].filter(
    (id): id is string => Boolean(id),
  );

  const parties = partyIds.length
    ? await db
        .select({
          id: contacts.id,
          name: contacts.name,
          email: contacts.primaryEmail,
          phone: contacts.primaryPhone,
        })
        .from(contacts)
        .where(inArray(contacts.id, partyIds))
    : [];

  const party = (id: string | null) => {
    if (!id) return null;
    const found = parties.find((entry) => entry.id === id);
    return found ? { id: found.id, name: found.name, handle: found.email ?? found.phone } : null;
  };

  return {
    id: row.shipment.id,
    trackingNumber: row.shipment.trackingNumber,
    statusLabel: row.shipment.statusLabel,
    statusAt: row.shipment.statusAt,
    syncState: row.shipment.syncState,
    lastSyncedAt: row.shipment.lastSyncedAt,
    shippingAccountId: row.shipment.shippingAccountId,
    sbid: row.sbid,
    shipper: party(row.shipment.shipperContactId),
    recipient: party(row.shipment.recipientContactId),
  };
}

export async function getShippingAccountBySbid(
  sbid: string,
): Promise<ShippingAccountDetail | null> {
  const canonical = normaliseSbid(sbid);
  if (!canonical) return null;

  const rows = await db
    .select({
      id: shippingAccounts.id,
      sbid: shippingAccounts.sbid,
      name: shippingAccounts.name,
      syncState: shippingAccounts.syncState,
      companyId: shippingAccounts.companyId,
      companyName: companies.name,
    })
    .from(shippingAccounts)
    .leftJoin(companies, eq(companies.id, shippingAccounts.companyId))
    .where(eq(shippingAccounts.sbid, canonical))
    .limit(1);

  return rows[0] ?? null;
}

/** Everyone who can speak for an account. */
export async function contactsForSbid(sbid: string): Promise<ContactSummary[]> {
  const canonical = normaliseSbid(sbid);
  if (!canonical) return [];

  return db
    .select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.primaryEmail,
      phone: contacts.primaryPhone,
      isShipper: contacts.isShipper,
      isRecipient: contacts.isRecipient,
      linkSource: contactShippingAccounts.linkSource,
    })
    .from(contactShippingAccounts)
    .innerJoin(contacts, eq(contacts.id, contactShippingAccounts.contactId))
    .innerJoin(shippingAccounts, eq(shippingAccounts.id, contactShippingAccounts.shippingAccountId))
    .where(and(eq(shippingAccounts.sbid, canonical), isNull(contacts.deletedAt)))
    .orderBy(contacts.name);
}

/** Recent shipments on an account, for its console page. */
export async function shipmentsForSbid(sbid: string, limit = 25) {
  const canonical = normaliseSbid(sbid);
  if (!canonical) return [];

  return db
    .select({
      id: shipments.id,
      trackingNumber: shipments.trackingNumber,
      statusLabel: shipments.statusLabel,
      syncState: shipments.syncState,
      createdAt: shipments.createdAt,
    })
    .from(shipments)
    .innerJoin(shippingAccounts, eq(shippingAccounts.id, shipments.shippingAccountId))
    .where(eq(shippingAccounts.sbid, canonical))
    .orderBy(desc(shipments.createdAt))
    .limit(limit);
}

/**
 * What the ticket sidebar shows.
 *
 * The requester's role is derived here rather than stored on the link, so it can
 * never disagree with the shipment it describes — see `roles.ts`.
 */
export async function shipmentsForConversation(
  conversationId: string,
  requesterContactId: string,
): Promise<LinkedShipment[]> {
  const rows = await db
    .select({
      shipmentId: shipments.id,
      trackingNumber: shipments.trackingNumber,
      statusLabel: shipments.statusLabel,
      statusAt: shipments.statusAt,
      lastSyncedAt: shipments.lastSyncedAt,
      currentEstimatedDate: shipments.currentEstimatedDate,
      syncState: shipments.syncState,
      shipperContactId: shipments.shipperContactId,
      recipientContactId: shipments.recipientContactId,
      sbid: shippingAccounts.sbid,
      linkSource: conversationShipments.linkSource,
      linkedAt: conversationShipments.createdAt,
    })
    .from(conversationShipments)
    .innerJoin(shipments, eq(shipments.id, conversationShipments.shipmentId))
    .leftJoin(shippingAccounts, eq(shippingAccounts.id, shipments.shippingAccountId))
    .where(eq(conversationShipments.conversationId, conversationId))
    .orderBy(desc(conversationShipments.createdAt));

  /*
   * Which of them are going back, asked for separately.
   *
   * `shipments.data` is the only place `rto_requested` lives, and reading that
   * column is confined to `lookup.ts` and `detail.ts` — so this asks them for
   * the answer rather than selecting the payload into a list query. One round
   * trip for the whole list; see `returnsForShipments`.
   */
  const returns = await returnsForShipments(rows.map((row) => row.shipmentId));

  return rows.map((row) => ({
    shipmentId: row.shipmentId,
    trackingNumber: row.trackingNumber,
    statusLabel: row.statusLabel,
    statusAt: row.statusAt,
    lastSyncedAt: row.lastSyncedAt,
    returnStep: returns.get(row.shipmentId)?.step ?? null,
    currentEstimatedDate: row.currentEstimatedDate,
    syncState: row.syncState,
    sbid: row.sbid,
    requesterRole: deriveRequesterRole(requesterContactId, {
      syncState: row.syncState,
      shipperContactId: row.shipperContactId,
      recipientContactId: row.recipientContactId,
    }),
    linkSource: row.linkSource,
    linkedAt: row.linkedAt,
  }));
}

export async function shippingAccountsForConversation(
  conversationId: string,
): Promise<LinkedShippingAccount[]> {
  return db
    .select({
      shippingAccountId: shippingAccounts.id,
      sbid: shippingAccounts.sbid,
      name: shippingAccounts.name,
      linkSource: conversationShippingAccounts.linkSource,
      linkedAt: conversationShippingAccounts.createdAt,
    })
    .from(conversationShippingAccounts)
    .innerJoin(
      shippingAccounts,
      eq(shippingAccounts.id, conversationShippingAccounts.shippingAccountId),
    )
    .where(eq(conversationShippingAccounts.conversationId, conversationId))
    .orderBy(desc(conversationShippingAccounts.createdAt));
}

/** The accounts a person can speak for, for their contact page and the sidebar. */
export async function shippingAccountsForContact(
  contactId: string,
): Promise<LinkedShippingAccount[]> {
  return db
    .select({
      shippingAccountId: shippingAccounts.id,
      sbid: shippingAccounts.sbid,
      name: shippingAccounts.name,
      linkSource: contactShippingAccounts.linkSource,
      linkedAt: contactShippingAccounts.createdAt,
    })
    .from(contactShippingAccounts)
    .innerJoin(shippingAccounts, eq(shippingAccounts.id, contactShippingAccounts.shippingAccountId))
    .where(eq(contactShippingAccounts.contactId, contactId))
    .orderBy(shippingAccounts.sbid);
}

/** Shipments a person is named on, for their contact page. */
export async function shipmentsForContact(contactId: string, limit = 25) {
  return db
    .select({
      id: shipments.id,
      trackingNumber: shipments.trackingNumber,
      statusLabel: shipments.statusLabel,
      syncState: shipments.syncState,
      isShipper: sql<boolean>`${shipments.shipperContactId} = ${contactId}`,
      isRecipient: sql<boolean>`${shipments.recipientContactId} = ${contactId}`,
      createdAt: shipments.createdAt,
    })
    .from(shipments)
    .where(
      or(eq(shipments.shipperContactId, contactId), eq(shipments.recipientContactId, contactId)),
    )
    .orderBy(desc(shipments.createdAt))
    .limit(limit);
}

/**
 * The console's contact search: people, accounts and shipments in one box.
 *
 * ILIKE rather than the plain `%` operator, per the README — `%` compares whole
 * strings and scores a short term against a long one below the threshold, so it
 * would match nothing. The trigram indexes accelerate all three.
 */
export async function searchContacts(query: string, limit = 20) {
  const q = query.trim();
  if (!q) return { contacts: [], accounts: [], shipments: [] };

  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  // A query with no alphanumerics normalises to '' and would become a bare '%%'
  // — every shipment in the account, presented as a search result.
  const canonical = normaliseTrackingNumber(q);
  const canonicalSbid = normaliseSbid(q);

  const [people, accounts, parcels] = await Promise.all([
    db
      .select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.primaryEmail,
        phone: contacts.primaryPhone,
        isShipper: contacts.isShipper,
        isRecipient: contacts.isRecipient,
      })
      .from(contacts)
      .where(
        and(
          isNull(contacts.deletedAt),
          or(
            ilike(contacts.name, pattern),
            ilike(contacts.primaryEmail, pattern),
            ilike(contacts.primaryPhone, pattern),
          ),
        ),
      )
      .orderBy(contacts.name)
      .limit(limit),

    db
      .select({
        id: shippingAccounts.id,
        sbid: shippingAccounts.sbid,
        name: shippingAccounts.name,
        syncState: shippingAccounts.syncState,
      })
      .from(shippingAccounts)
      .where(
        canonicalSbid
          ? or(
              ilike(shippingAccounts.sbid, `%${canonicalSbid}%`),
              ilike(shippingAccounts.name, pattern),
            )
          : ilike(shippingAccounts.name, pattern),
      )
      .orderBy(shippingAccounts.sbid)
      .limit(limit),

    db
      .select({
        id: shipments.id,
        trackingNumber: shipments.trackingNumber,
        statusLabel: shipments.statusLabel,
        syncState: shipments.syncState,
      })
      .from(shipments)
      .where(canonical ? ilike(shipments.trackingNumber, `%${canonical}%`) : sql`false`)
      .orderBy(desc(shipments.createdAt))
      .limit(limit),
  ]);

  return { contacts: people, accounts, shipments: parcels };
}
