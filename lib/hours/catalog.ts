import { isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { businessHours, groups, holidays } from '@/db/schema';
import type { HoursConfig } from './index';
import { emptyCatalog, type HoursCatalog } from './resolve';

/**
 * Loading every schedule, its holidays and the group overrides in three queries.
 *
 * Loaded whole rather than per ticket. There are a handful of schedules and a
 * handful of groups, the SLA sweep and the nightly rollup both walk thousands of
 * tickets, and a per-ticket lookup would turn that into thousands of round trips
 * for the same dozen rows.
 */
export async function loadHoursCatalog(): Promise<HoursCatalog> {
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
        name: holidays.name,
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
    config?.holidays?.push({ date: row.date, name: row.name });
  }

  for (const row of groupRows) {
    // A group pointing at a schedule that no longer exists is left out, so it
    // falls back to the default instead of resolving to no hours at all.
    if (row.businessHoursId && catalog.schedules.has(row.businessHoursId)) {
      catalog.overrides.set(row.id, row.businessHoursId);
    }
  }

  return catalog;
}
