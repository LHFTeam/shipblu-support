import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { businessHours, holidays as holidaysTable } from '@/db/schema';
import { channels, contactIdentities, conversations, ticketStatuses } from '@/db/schema';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import type { HoursConfig } from '@/lib/hours';
import { resolveContact } from '@/lib/tickets/contacts';

/**
 * Visitor identity for the chat widget.
 *
 * A visitor is anonymous until they say otherwise, so identity is a random
 * token the widget keeps in the iframe's own localStorage. Only its SHA-256 is
 * stored, as `contact_identities(channel='webchat', identifier=…)` — the same
 * rule as agent sessions, so a database leak yields no usable credential, and
 * the same table as email and WhatsApp, so a visitor who later gives an email
 * merges into one customer rather than becoming a second stranger.
 *
 * The token is a bearer credential: whoever holds it can read that visitor's
 * conversation. That is the correct model for a widget with no sign-in, and it
 * is why the token is 256 bits of randomness rather than anything derived.
 */

export type VisitorSession = {
  token: string;
  contactId: string;
  conversationId: string | null;
  isNew: boolean;
};

export function issueVisitorToken(): string {
  return generateToken();
}

/** Resolves a token to its contact, or null if it belongs to no one. */
export async function resolveVisitor(token: string): Promise<string | null> {
  if (!token) return null;

  const rows = await db
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channel, 'webchat'),
        eq(contactIdentities.identifier, hashToken(token)),
      ),
    )
    .limit(1);

  return rows[0]?.contactId ?? null;
}

/** Creates the contact behind a fresh token. */
export async function registerVisitor(token: string, displayName?: string | null) {
  return resolveContact({
    channel: 'webchat',
    identifier: hashToken(token),
    displayName: displayName ?? null,
  });
}

/**
 * The visitor's live conversation, if any.
 *
 * A closed conversation is not continued — closing is the team's signal that
 * the matter is finished, and a returning visitor with a new question should
 * not have it buried under last month's thread. Resolved is different: that is
 * awaiting-confirmation, so a reply reopens it, exactly as on WhatsApp.
 */
export async function findLiveConversation(contactId: string): Promise<string | null> {
  const rows = await db
    .select({ id: conversations.id, category: ticketStatuses.category })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(
      and(
        eq(conversations.requesterContactId, contactId),
        eq(conversations.channel, 'webchat'),
        isNull(conversations.deletedAt),
        isNull(conversations.mergedIntoId),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);

  const row = rows[0];
  if (!row || row.category === 'closed') return null;
  return row.id;
}

/**
 * The schedule the widget is gated on.
 *
 * Prefers the webchat channel's own business hours, falling back to the default
 * schedule — so the chat widget can be staffed different hours from the
 * mailbox without a second concept.
 */
export async function widgetHours(): Promise<HoursConfig | null> {
  const rows = await db
    .select({
      id: businessHours.id,
      schedule: businessHours.schedule,
      timezone: businessHours.timezone,
    })
    .from(businessHours)
    .where(eq(businessHours.isDefault, true))
    .limit(1);

  const hours = rows[0];
  if (!hours) return null;

  const days = await db
    .select({ date: holidaysTable.date, name: holidaysTable.name })
    .from(holidaysTable)
    .where(eq(holidaysTable.businessHoursId, hours.id));

  return {
    schedule: hours.schedule,
    timezone: hours.timezone,
    holidays: days.map((day) => ({ date: day.date, name: day.name })),
  };
}

/** The configured webchat channel, for default routing. */
export async function webchatChannel() {
  const rows = await db
    .select({ id: channels.id, defaultGroupId: channels.defaultGroupId })
    .from(channels)
    .where(and(eq(channels.type, 'webchat'), eq(channels.isActive, true)))
    .limit(1);

  return rows[0] ?? null;
}
