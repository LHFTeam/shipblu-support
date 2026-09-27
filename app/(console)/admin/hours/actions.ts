'use server';

import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { businessHours, holidays } from '@/db/schema';
import type { WeeklySchedule } from '@/db/schema/config';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { TEAM_TIME_ZONE } from '@/lib/hours/zone';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- Business hours ---------------------------------------------------------

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export async function saveBusinessHours(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  const timezone = text(formData, 'timezone') || TEAM_TIME_ZONE;

  if (!name) return { error: 'Give the schedule a name' };

  // An unknown zone would make every SLA due date null, and the failure would
  // show up days later as tickets that never breach.
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return { error: `"${timezone}" is not a timezone this server recognises` };
  }

  const schedule = {} as WeeklySchedule;
  for (const day of DAYS) {
    const closed = formData.get(`${day}_closed`) === 'on';
    const start = text(formData, `${day}_start`);
    const end = text(formData, `${day}_end`);

    if (closed || !start || !end) {
      schedule[day] = [];
      continue;
    }

    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      return { error: `${day}: times must look like 09:00` };
    }
    if (end <= start) {
      return { error: `${day}: the closing time must be after the opening time` };
    }

    schedule[day] = [{ start, end }];
  }

  const isDefault = formData.get('isDefault') === 'on';

  await db.transaction(async (tx) => {
    if (isDefault) {
      await tx.update(businessHours).set({ isDefault: false });
    }

    if (id) {
      await tx
        .update(businessHours)
        .set({ name, timezone, schedule, isDefault, updatedAt: new Date() })
        .where(eq(businessHours.id, id));
    } else {
      await tx.insert(businessHours).values({ name, timezone, schedule, isDefault });
    }
  });

  // The catalogue is memoised for thirty seconds and a due date is computed
  // from it, so the process that took the edit drops its copy now rather than
  // serving a stale schedule to the next SLA calculation.
  forgetHoursCatalog();
  refresh('/admin/hours');
  return ok();
}

/**
 * Add a holiday, or correct one that is already on the calendar.
 *
 * Editing exists because the name is now the part most likely to be wrong — it
 * reaches a customer through `{{holiday}}`, and it is typed twice, in two
 * scripts. Before this the only way to change it was to delete the row and add
 * it again, which is not a repair anybody guesses at.
 *
 * A duplicate date is **refused rather than ignored.** The insert used to be
 * `onConflictDoNothing()` followed by `ok()`, so retyping a date the calendar
 * already had reported success and changed nothing — the one shape of failure
 * this codebase calls worse than an error, and it landed on exactly the person
 * trying to fix a name. The insert keeps the conflict clause so a race cannot
 * raise instead, and an insert that touched no row is now the error message.
 */
export async function saveHoliday(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const date = text(formData, 'date');
  const nameAr = text(formData, 'nameAr');
  const nameEn = text(formData, 'nameEn');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date' };

  // One name is enough — `holidayName` falls back to whichever was written —
  // but a holiday with neither leaves `{{holiday}}` empty in an out-of-hours
  // message that only exists to say which day it is.
  if (!nameAr && !nameEn) return { error: 'Name the holiday in at least one language' };

  const taken = 'That schedule already has a holiday on that date';

  /*
    The superseded single name, written for as long as the column exists.

    Same reason as `saveCannedResponse`: only the two web services run
    `db:migrate`, and `loadHoursCatalog` on the still-old worker and crons
    selects `holidays.name`. Leaving it at its default would mean a holiday added
    today closes the office correctly on old code and interpolates nothing into
    `{{holiday}}` — a message whose whole job is naming the day. Arabic first,
    like the canned pair. Goes when the column does.
  */
  const name = nameAr || nameEn;

  if (id) {
    // The schedule comes from the stored row, never from the form: the hidden
    // field is a claim by whoever posted it, and honouring it would let one
    // move a holiday onto a calendar the page never showed.
    const existing = await db
      .select({ businessHoursId: holidays.businessHoursId })
      .from(holidays)
      .where(eq(holidays.id, id))
      .limit(1);

    const row = existing[0];
    if (!row) return { error: 'That holiday has already been removed' };

    // Moving a holiday onto a date its own calendar already uses. Checked
    // rather than left to the unique index, which would surface as a 500.
    const clash = await db
      .select({ id: holidays.id })
      .from(holidays)
      .where(
        and(
          eq(holidays.businessHoursId, row.businessHoursId),
          eq(holidays.date, date),
          ne(holidays.id, id),
        ),
      )
      .limit(1);

    if (clash.length > 0) return { error: taken };

    await db.update(holidays).set({ date, nameAr, nameEn, name }).where(eq(holidays.id, id));
  } else {
    const businessHoursId = text(formData, 'businessHoursId');
    if (!businessHoursId) return { error: 'Pick a schedule' };

    const inserted = await db
      .insert(holidays)
      .values({ businessHoursId, date, nameAr, nameEn, name })
      .onConflictDoNothing()
      .returning({ id: holidays.id });

    if (inserted.length === 0) return { error: taken };
  }

  // The catalogue is memoised for thirty seconds and a due date is computed
  // from it, so the process that took the edit drops its copy now rather than
  // serving a stale schedule to the next SLA calculation.
  forgetHoursCatalog();
  refresh('/admin/hours');
  return ok();
}

export async function deleteHoliday(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };
  await db.delete(holidays).where(eq(holidays.id, id));
  // The catalogue is memoised for thirty seconds and a due date is computed
  // from it, so the process that took the edit drops its copy now rather than
  // serving a stale schedule to the next SLA calculation.
  forgetHoursCatalog();
  refresh('/admin/hours');
  return ok();
}
