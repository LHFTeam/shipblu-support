import type { HoursConfig } from './index';

/**
 * Which calendar a ticket's clock runs on.
 *
 * There is one global default schedule and, optionally, a schedule per group —
 * the same shape Freshdesk and Freshchat have, where the account has business
 * hours and a group may keep its own. A group's schedule brings its own
 * timezone, operating days *and* holidays with it, because all three live on the
 * `business_hours` row: a team that works Saturdays and takes different holidays
 * is one calendar, not three settings that have to agree.
 *
 * Resolution is pure and lives apart from the queries that load it (`./catalog`)
 * so that the SLA engine, the nightly rollup and the chat widget all answer
 * "which hours apply here?" with the same function. A due date computed against
 * one calendar and then reported against another is the kind of disagreement
 * nobody notices until a team is arguing about a number.
 */

export type HoursSource = 'group' | 'schedule' | 'round_the_clock';

export type HoursCatalog = {
  /** Every schedule, by id, with its holidays already attached. */
  schedules: Map<string, HoursConfig>;
  /** The global default, or null if nobody has marked one. */
  defaultId: string | null;
  /** Group id → the schedule that group overrides with. */
  overrides: Map<string, string>;
};

export function emptyCatalog(): HoursCatalog {
  return { schedules: new Map(), defaultId: null, overrides: new Map() };
}

export function scheduleById(catalog: HoursCatalog, id: string | null): HoursConfig | null {
  if (!id) return null;
  return catalog.schedules.get(id) ?? null;
}

/** The global default schedule — what applies when nothing more specific does. */
export function defaultHours(catalog: HoursCatalog): HoursConfig | null {
  return scheduleById(catalog, catalog.defaultId);
}

/**
 * A group's own hours, or the default when it has none.
 *
 * The fallback is the point: an admin sets a schedule on the one team that works
 * unusual days and every other group keeps working the global one, with no
 * per-group configuration to maintain.
 */
export function groupHours(catalog: HoursCatalog, groupId: string | null): HoursConfig | null {
  const override = groupId ? catalog.overrides.get(groupId) : undefined;
  return scheduleById(catalog, override ?? catalog.defaultId);
}

/** What a policy says about hours; null for a ticket with no policy at all. */
export type PolicyHours = {
  hoursSource: HoursSource;
  businessHoursId: string | null;
};

/**
 * The calendar a ticket's SLA clock and its reported working time run on.
 *
 * Null means round-the-clock: wall-clock time, no schedule. That is a real
 * answer, not a failure — a policy can be configured for it, and so is a
 * deployment where nobody has set up business hours at all.
 *
 * A ticket with no policy (`policy` null) still resolves to its group's hours.
 * Reporting measures response times on every ticket, and the same overnight wait
 * must not count differently depending on whether anyone got round to writing an
 * SLA for it.
 */
export function ticketHours(
  catalog: HoursCatalog,
  groupId: string | null,
  policy: PolicyHours | null,
): HoursConfig | null {
  if (!policy) return groupHours(catalog, groupId);

  switch (policy.hoursSource) {
    case 'round_the_clock':
      return null;

    // An explicitly named schedule outranks the group's: the admin pointed this
    // policy at one calendar, and silently swapping it for the group's would
    // make the setting a lie.
    case 'schedule':
      return scheduleById(catalog, policy.businessHoursId) ?? defaultHours(catalog);

    case 'group':
    default:
      return groupHours(catalog, groupId);
  }
}
