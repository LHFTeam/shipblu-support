import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  companies,
  contactIdentities,
  contacts,
  conversations,
  ticketStatuses,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { conversationVisibility } from '@/lib/tickets/queries';
import type { ConversationSummary } from '@/lib/shipments/queries';

/**
 * The contact read model.
 *
 * There has been no contact page in this console since it was built —
 * `contact.view` and `contact.edit` have existed in the permission list from the
 * start and were checked nowhere. The shipment work is what finally needs one:
 * "track conversations by customer" has to land somewhere, and the honest place
 * to say "this person can speak for these accounts" is on the person.
 */

export type ContactDetail = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  locale: string;
  isBlocked: boolean;
  isShipper: boolean;
  isRecipient: boolean;
  companyId: string | null;
  companyName: string | null;
  createdAt: Date;
  identities: { id: string; channel: string; identifier: string; isVerified: boolean }[];
};

export async function getContact(contactId: string): Promise<ContactDetail | null> {
  const rows = await db
    .select({
      contact: contacts,
      companyName: companies.name,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const identities = await db
    .select({
      id: contactIdentities.id,
      channel: contactIdentities.channel,
      identifier: contactIdentities.identifier,
      isVerified: contactIdentities.isVerified,
    })
    .from(contactIdentities)
    .where(eq(contactIdentities.contactId, contactId))
    .orderBy(contactIdentities.channel);

  return {
    id: row.contact.id,
    name: row.contact.name,
    email: row.contact.primaryEmail,
    phone: row.contact.primaryPhone,
    locale: row.contact.locale,
    isBlocked: row.contact.isBlocked,
    isShipper: row.contact.isShipper,
    isRecipient: row.contact.isRecipient,
    companyId: row.contact.companyId,
    companyName: row.companyName,
    createdAt: row.contact.createdAt,
    identities,
  };
}

/**
 * A contact's own tickets.
 *
 * Scoped through `conversationVisibility` rather than a fresh set of clauses, so
 * this page cannot show an agent a ticket the inbox would have hidden from them.
 */
export async function conversationsForContact(
  agent: SessionAgent,
  contactId: string,
  limit = 25,
): Promise<ConversationSummary[]> {
  const rows = await db
    .select({
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
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .innerJoin(contacts, eq(contacts.id, conversations.requesterContactId))
    .leftJoin(agents, eq(agents.id, conversations.assigneeAgentId))
    .where(and(eq(conversations.requesterContactId, contactId), ...conversationVisibility(agent)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit);

  return rows.map((row) => ({
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
  }));
}
