/**
 * The custom fields an admin defines under Settings → Ticket fields.
 *
 * The definitions have existed since the first migration and `lib/rules/facts.ts`
 * has always read `conversations.custom_fields` to answer `custom.<key>` — but
 * nothing ever *wrote* that column, so every condition on a custom field matched
 * nothing and said so to no one. This module and its sibling are the write side.
 *
 * Split across two files, by which side of the wire runs them rather than by
 * subject. The console's sidebar is a client component, so everything it imports
 * lands in the bundle an agent downloads on the busiest route in the product;
 * turning a wall clock into an instant needs the timezone database and luxon
 * with it, and that has never been in a client bundle here. So the direction
 * that needs it — `parseFieldValue` in `./custom-fields-parse.ts` — is server
 * only, and this file stays free of it: `Intl` resolves Cairo the other way
 * round on its own, which is what `lib/format.ts` already relies on.
 */

const ZONE = 'Africa/Cairo';

export type TicketFieldType =
  | 'text'
  | 'paragraph'
  | 'number'
  | 'decimal'
  | 'checkbox'
  | 'dropdown'
  | 'multi_select'
  | 'date'
  | 'datetime';

/**
 * The subset of a `ticket_fields` row this needs.
 *
 * Deliberately not the Drizzle row type: the portal builds these from a query
 * that never selects the admin-only columns, and widening the parameter would
 * invite a caller to pass a row that has not been filtered for the customer.
 */
export type TicketFieldDef = {
  key: string;
  label: string;
  type: TicketFieldType;
  options: { value: string; label: string }[];
  requiredOnCreate: boolean;
  requiredOnResolve: boolean;
  visibleToCustomer: boolean;
  editableByCustomer: boolean;
};

export type CustomFieldValues = Record<string, unknown>;

/**
 * What "empty" means, and it is deliberately the same answer
 * `lib/rules/conditions.ts` gives.
 *
 * An admin who marks a field required and also writes `custom.x is_empty` is
 * asking one question in two places; two definitions would let a ticket be both
 * complete and empty at once, and only one of the two would be visible on screen.
 *
 * So `false` is a value, not a blank — which means a required checkbox is
 * satisfied by either answer, because "no" *is* an answer. A box that must be
 * ticked is a consent control, a different feature from a required field.
 */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * The stored value rendered back into what the form control expects.
 *
 * The inverse of `parseFieldValue` for the one type where they differ: a stored
 * instant has to come back as Cairo wall clock, or the agent is shown a time
 * nobody entered. `Intl` does that direction with the timezone database the
 * runtime already carries, so it is right across a DST change without pulling a
 * date library into the browser.
 */
export function formatForInput(def: TicketFieldDef, value: unknown): string {
  if (value === null || value === undefined) return '';

  if (def.type === 'datetime') {
    if (typeof value !== 'string') return '';
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) return '';

    // `formatToParts` rather than a formatted string: `datetime-local` wants
    // exactly `yyyy-MM-ddTHH:mm`, and every locale's own rendering of that is
    // something else.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);

    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value ?? '';

    // Midnight comes back as hour 24 in some ICU versions rather than 00.
    const hour = part('hour') === '24' ? '00' : part('hour');

    return `${part('year')}-${part('month')}-${part('day')}T${hour}:${part('minute')}`;
  }

  if (def.type === 'checkbox') return value === true ? 'on' : '';
  if (Array.isArray(value)) return value.map(String).join(', ');

  return String(value);
}

/** The stored selections for a multi-select, as a list the checkboxes can test. */
export function selectedValues(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * The required fields a ticket has not answered, for whichever gate is being
 * checked.
 *
 * Returns the definitions rather than a boolean so the caller can name them:
 * "Fill in Warehouse and Refund amount before resolving" is actionable, and
 * "some required fields are empty" sends an agent hunting through a sidebar.
 */
export function missingRequired(
  defs: TicketFieldDef[],
  values: CustomFieldValues,
  phase: 'create' | 'resolve',
): TicketFieldDef[] {
  return defs.filter((def) => {
    const required = phase === 'create' ? def.requiredOnCreate : def.requiredOnResolve;
    return required && isBlank(values[def.key]);
  });
}

/** "Warehouse", or "Warehouse and Refund amount", or "A, B and C". */
export function listLabels(defs: TicketFieldDef[]): string {
  const labels = defs.map((def) => def.label);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
