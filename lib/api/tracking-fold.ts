import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * How `GET /tickets?trackingNumber=` folds the number stored on a ticket's
 * ownership row, for comparing it with the asked number folded by
 * `normaliseTrackingNumber`, as every reader of a tracking number folds one.
 *
 * The stored side is only case and hyphens, where `normaliseTrackingNumber`
 * also strips whitespace and `_ . / \ : #`, invisible characters, and folds
 * Arabic-Indic digits. The two agree only because `TrackingNumber`
 * (`lib/api/schemas.ts`) admits `A-Z a-z 0-9 -` and nothing else, on the
 * create that stores the number and on the list that asks for it, and
 * `createApiTicket` is the one writer of `api_tickets.tracking_number`.
 * Widened, the filter would quietly find nothing, and the app's shipment
 * screen would show no ticket and no error. `tracking-fold.test.ts` holds the
 * two to that: it fails the moment the pattern admits a character the
 * normaliser treats as more than case or a hyphen, and the fold here then
 * changes with it — or a normalised copy is stored beside the number.
 */
export function trackingFoldSql(column: AnyPgColumn): SQL<string> {
  return sql<string>`upper(replace(${column}, '-', ''))`;
}

/** `trackingFoldSql` in JavaScript, for the test that holds it to the normaliser. */
export function storedTrackingFold(value: string): string {
  return value.replaceAll('-', '').toUpperCase();
}
