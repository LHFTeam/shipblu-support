import { and, asc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  cannedResponses,
  groupMembers,
  groups,
  ticketFields,
  ticketStatuses,
  whatsappTemplates,
} from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import type { TicketFieldDef } from './custom-fields';
import { ownerOnlyNumber, seesOwnerOnlyTicket } from './owner-only';

// --- Lookups the console's controls are built from -------------------------

export async function listStatuses() {
  return db
    .select({
      id: ticketStatuses.id,
      name: ticketStatuses.name,
      category: ticketStatuses.category,
    })
    .from(ticketStatuses)
    .orderBy(asc(ticketStatuses.position));
}

/**
 * The custom fields a ticket can carry, in the order an admin arranged them.
 *
 * Active fields only. Deactivating a field takes it off every form without
 * touching the values already stored, which is the point of the flag: a field
 * retired mid-quarter must not erase the answers the last three months of
 * tickets gave it, and a rule still reading `custom.<key>` keeps working on them.
 */
export async function listTicketFields(): Promise<TicketFieldDef[]> {
  return selectFields(true);
}

/**
 * Every field, including the retired ones.
 *
 * For the two screens that must not pretend a deactivated field never existed:
 * the form builder, which has to render a question already placed on a form, and
 * `saveTicketForm`, which parses against this so that deactivating a field does
 * not make every form placing it permanently unsavable. Everything a *customer*
 * sees goes through `listTicketFields` and its active-only filter.
 */
export async function listAllTicketFields(): Promise<TicketFieldDef[]> {
  return selectFields(false);
}

function selectFields(activeOnly: boolean): Promise<TicketFieldDef[]> {
  const query = db
    .select({
      key: ticketFields.key,
      label: ticketFields.label,
      labelAr: ticketFields.labelAr,
      labelEn: ticketFields.labelEn,
      type: ticketFields.type,
      options: ticketFields.options,
      validation: ticketFields.validation,
      requiredOnCreate: ticketFields.requiredOnCreate,
      requiredOnResolve: ticketFields.requiredOnResolve,
      visibleToCustomer: ticketFields.visibleToCustomer,
      editableByCustomer: ticketFields.editableByCustomer,
    })
    .from(ticketFields)
    .$dynamic();

  return (activeOnly ? query.where(eq(ticketFields.isActive, true)) : query).orderBy(
    asc(ticketFields.position),
    asc(ticketFields.label),
  );
}

/**
 * The one field a write is allowed to touch, re-read from the database.
 *
 * The key arrives in a FormData field, so the definition behind it is never
 * taken from the request: the type decides how the value is parsed and the
 * options decide what is accepted, and a caller who could supply those could
 * store anything under any key.
 */
export async function getTicketField(key: string): Promise<TicketFieldDef | null> {
  const rows = await listTicketFields();
  return rows.find((field) => field.key === key) ?? null;
}

/**
 * The canned responses this agent may insert.
 *
 * Three visibilities, and the scoping is the whole point of doing it in the
 * query rather than filtering a full list afterwards: `personal` belongs to one
 * agent and `group` to one team, so a list built without the `where` and
 * narrowed in the renderer is a list that was already sent to the browser. A
 * personal response is somebody's own draft wording — often with a name or an
 * account number still in it — and a group's belongs to a team this agent may
 * not be on.
 *
 * The rule itself is `cannedVisibleTo`, shared with the usage counter.
 */
export async function listCannedResponses(agent: SessionAgent) {
  return db
    .select({
      id: cannedResponses.id,
      title: cannedResponses.title,
      folder: cannedResponses.folder,
      // Both languages, because the choice between them is the agent's and it
      // is made after the list has rendered. Fetching the picked one on demand
      // would put a round trip inside a dropdown's onChange.
      bodyTextAr: cannedResponses.bodyTextAr,
      bodyTextEn: cannedResponses.bodyTextEn,
    })
    .from(cannedResponses)
    .where(cannedVisibleTo(agent.id))
    .orderBy(asc(cannedResponses.folder), asc(cannedResponses.title));
}

/**
 * Whether a canned response is one this agent may insert.
 *
 * One predicate for the two places that ask: the composer's list, and
 * `recordCannedUse`, which re-reads the row a reply's `cannedResponseId` names
 * rather than trusting the form — so an agent cannot score a use against
 * somebody else's personal response, or a team's they are not on, by posting
 * its id.
 *
 * `agent_id` and `group_id` are only meaningful for their own visibility, so
 * each arm tests both: a `global` row with a stale `agent_id` left on it from an
 * earlier edit is still global, and a `personal` row whose `agent_id` is null is
 * visible to nobody rather than to everybody.
 */
export function cannedVisibleTo(agentId: string): SQL {
  return or(
    eq(cannedResponses.visibility, 'global'),
    and(eq(cannedResponses.visibility, 'personal'), eq(cannedResponses.agentId, agentId)),
    and(
      eq(cannedResponses.visibility, 'group'),
      inArray(
        cannedResponses.groupId,
        db
          .select({ id: groupMembers.groupId })
          .from(groupMembers)
          .where(eq(groupMembers.agentId, agentId)),
      ),
    ),
  )!;
}

export type CannedResponseOption = Awaited<ReturnType<typeof listCannedResponses>>[number];

/**
 * The agents a ticket's Assignee picker offers: every active agent, or, on a
 * coexistence number, only those the ticket is not hidden from — its owner and
 * the agents who see every ticket (`lib/tickets/owner-only.ts`). The action
 * refuses anybody else, so offering them would be a list of refusals.
 *
 * Whoever holds the ticket now stays in the list though they could not be
 * chosen again: a select whose value names no option draws its first one, and
 * a ticket held by a colleague would read "Unassigned".
 *
 * One read after the other, not at once: the ticket page asks this inside a
 * batch that already fills the pool's places (§6.91), and a ticket off
 * WhatsApp has no number to ask about.
 */
export async function listAssignableAgents(ticket: {
  channelId: string | null;
  assigneeAgentId: string | null;
}) {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      email: agents.email,
      role: agents.role,
      permissions: agents.permissions,
    })
    .from(agents)
    .where(eq(agents.isActive, true))
    .orderBy(asc(agents.name));
  const number = await ownerOnlyNumber(db, ticket.channelId);
  return rows
    .filter(
      (row) =>
        !number || row.id === ticket.assigneeAgentId || seesOwnerOnlyTicket(row, number.ownerId),
    )
    .map(({ id, name, email }) => ({ id, name, email }));
}

export async function listGroups() {
  return db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name));
}

/**
 * Approved templates on one business account — anything else is rejected at
 * send time by Meta.
 *
 * Scoped to the account rather than listing the table, because a template is
 * approved on a WABA and not on the installation. Two connected accounts can
 * both have `shipment_update`, approved on one and rejected on the other, and
 * an unscoped picker would offer the agent whichever row happened to be there.
 * The send then fails asynchronously, on a status webhook, after the agent has
 * already been told it went.
 *
 * `null` means the rows that predate business accounts, which is the whole
 * table until the first sync adopts them.
 */
export async function listApprovedTemplates(whatsappAccountId: string | null) {
  return db
    .select({
      id: whatsappTemplates.id,
      name: whatsappTemplates.name,
      language: whatsappTemplates.language,
      category: whatsappTemplates.category,
      components: whatsappTemplates.components,
    })
    .from(whatsappTemplates)
    .where(
      and(
        eq(whatsappTemplates.status, 'APPROVED'),
        whatsappAccountId
          ? eq(whatsappTemplates.whatsappAccountId, whatsappAccountId)
          : isNull(whatsappTemplates.whatsappAccountId),
      ),
    )
    .orderBy(asc(whatsappTemplates.name));
}
