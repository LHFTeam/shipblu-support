import { isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { businessHours, groups, holidays } from '@/db/schema';
import type { HoursConfig } from './index';
import { emptyCatalog, type HoursCatalog } from './resolve';

/**
 * Memoised for thirty seconds, in the shape `lib/presence/policy.ts` uses.
 *
 * Loading whole was already the right call; loading it repeatedly was not. The
 * SLA sweep calls this **four times in one run** (`lib/sla/index.ts`), every
 * five minutes, and each call is three concurrent queries — so the sweep alone
 * asked twelve times an hour for a dozen rows that change when an admin edits a
 * schedule. `/ar` pays three of its eight concurrent queries here too, against a
 * `max: 10` pool (§62).
 *
 * Thirty seconds rather than longer because a due date is computed from this: a
 * schedule change that took minutes to apply would be a wrong deadline, not a
 * stale page. The TTL is the promise: every reader sees an edit within it — the
 * same trade `forgetPresencePolicy()` makes, and the reason the TTL is seconds.
 *
 * `forgetHoursCatalog()` shortens it only for the copy it can reach, which is
 * not the whole process. This memo lives in the module instance, and a Next
 * build loads the `route.ts` handlers and the pages with their server actions
 * through two Turbopack runtimes (`.next/server/chunks/` and
 * `.next/server/chunks/ssr/`), each with a module cache of its own. So the
 * admin's save clears the copy the console's pages and actions read, and every
 * route handler keeps its own until it expires — `GET /api/v1/config`'s
 * `support`, the widget's hours, and the due dates and out-of-hours replies a
 * message stored by a route computes. On a `next start` build an hours edit
 * reached `/api/v1/config` 19 and 27 seconds after the save. The worker and
 * the crons are processes of their own and never see the forget at all.
 *
 * It memoises the **value, not the promise**, like every other memo in `lib/`.
 * So several concurrent requests arriving in a cold window each still issue
 * their own three queries; single-flight has no precedent here and would be a
 * new pattern to maintain for a case this small.
 */
const CACHE_TTL_MS = 30_000;

let cached: { at: number; value: HoursCatalog } | null = null;

/**
 * Drop the memo after a write, so the admin who just saved a schedule sees it
 * applied rather than waiting out the TTL. Only this module instance — the
 * console's pages and actions, not the route handlers beside them; see above.
 */
export function forgetHoursCatalog(): void {
  cached = null;
}

/**
 * Loading every schedule, its holidays and the group overrides in three queries.
 *
 * Loaded whole rather than per ticket. There are a handful of schedules and a
 * handful of groups, the SLA sweep and the nightly rollup both walk thousands of
 * tickets, and a per-ticket lookup would turn that into thousands of round trips
 * for the same dozen rows.
 */
export async function loadHoursCatalog(): Promise<HoursCatalog> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const [scheduleRows, holidayRows, groupRows] = await Promise.all([
    db
      .select({
        id: businessHours.id,
        timezone: businessHours.timezone,
        schedule: businessHours.schedule,
        isDefault: businessHours.isDefault,
      })
      .from(businessHours),
    db
      .select({
        businessHoursId: holidays.businessHoursId,
        date: holidays.date,
        nameAr: holidays.nameAr,
        nameEn: holidays.nameEn,
      })
      .from(holidays),
    db
      .select({ id: groups.id, businessHoursId: groups.businessHoursId })
      .from(groups)
      .where(isNotNull(groups.businessHoursId)),
  ]);

  const catalog = emptyCatalog();

  for (const row of scheduleRows) {
    catalog.schedules.set(row.id, {
      schedule: row.schedule,
      timezone: row.timezone,
      holidays: [],
    } satisfies HoursConfig);

    // Two schedules both flagged default should not be possible — the admin
    // action clears the others — but if it ever happens, take the first rather
    // than letting row order decide it differently on every request.
    if (row.isDefault && !catalog.defaultId) catalog.defaultId = row.id;
  }

  for (const row of holidayRows) {
    const config = catalog.schedules.get(row.businessHoursId);
    config?.holidays?.push({ date: row.date, nameAr: row.nameAr, nameEn: row.nameEn });
  }

  for (const row of groupRows) {
    // A group pointing at a schedule that no longer exists is left out, so it
    // falls back to the default instead of resolving to no hours at all.
    if (row.businessHoursId && catalog.schedules.has(row.businessHoursId)) {
      catalog.overrides.set(row.id, row.businessHoursId);
    }
  }

  cached = { at: Date.now(), value: catalog };
  return catalog;
}
