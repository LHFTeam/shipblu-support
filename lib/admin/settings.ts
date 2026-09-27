import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  cannedResponses,
  locations,
  shipmentPhrases,
  ticketFields,
  ticketStatuses,
} from '@/db/schema';

/**
 * What each admin settings page lists: every row, active or not, in the order
 * the page shows them.
 *
 * Here rather than in the pages for the reason `./overview` is: a page is where
 * a query is first run in production, and the database tier can reach this
 * module (`settings.db.test.ts`). They stay apart from the runtime reads of the
 * same tables — the composer's canned-response picker, say — because those
 * answer a different question: what an agent may use now, not everything an
 * admin can edit.
 *
 * Authorisation is the page's, which calls `requirePermission` before any of
 * these.
 */

export function listCannedResponses() {
  return db
    .select()
    .from(cannedResponses)
    .orderBy(asc(cannedResponses.folder), asc(cannedResponses.title));
}

export function listTicketFields() {
  return db
    .select()
    .from(ticketFields)
    .orderBy(asc(ticketFields.position), asc(ticketFields.label));
}

export function listLocations() {
  return db
    .select({
      id: locations.id,
      name: locations.name,
      code: locations.code,
      email: locations.email,
      isActive: locations.isActive,
    })
    .from(locations)
    .orderBy(asc(locations.code));
}

export function listTicketStatuses() {
  return db
    .select()
    .from(ticketStatuses)
    .orderBy(asc(ticketStatuses.position), asc(ticketStatuses.name));
}

/** The Arabic wording an admin saved, by phrase key. Unsaved phrases have no row. */
export function listSavedPhrases() {
  return db.select({ key: shipmentPhrases.key, ar: shipmentPhrases.ar }).from(shipmentPhrases);
}
