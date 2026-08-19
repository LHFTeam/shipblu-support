import { asc, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { businessHours, groups, holidays } from '@/db/schema';
import { Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { HolidayList, HoursEditor, NewSchedule } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Business hours and holidays.
 *
 * This is what makes an SLA target mean four *working* hours. A ticket arriving
 * at 16:00 on a Thursday with a four-hour target is due at noon on Sunday, not
 * overnight on a day the office is shut — so the schedule here is not a
 * cosmetic setting, it is the arithmetic behind every due date.
 *
 * One schedule is the company default. Any number of others can exist for the
 * groups that work differently, and each card names the groups on it — a
 * schedule with nobody on it is either the default or a leftover, and that is
 * worth being able to tell apart at a glance.
 */
export default async function HoursPage() {
  await requirePermission('admin.sla');

  const [schedules, allHolidays, groupRows] = await Promise.all([
    db.select().from(businessHours).orderBy(asc(businessHours.name)),
    db.select().from(holidays).orderBy(asc(holidays.date)),
    db
      .select({ name: groups.name, businessHoursId: groups.businessHoursId })
      .from(groups)
      .where(isNotNull(groups.businessHoursId))
      .orderBy(asc(groups.name)),
  ]);

  return (
    <>
      <PageHeader
        title="Business hours"
        description="SLA targets are counted in working time, and reporting measures response times the same way. A group can be put on its own schedule; every other group works the default."
        actions={<NewSchedule />}
      />

      <div className="flex flex-col gap-4">
        {schedules.map((schedule) => (
          <Card key={schedule.id}>
            <HoursEditor
              schedule={schedule}
              groupNames={groupRows
                .filter((group) => group.businessHoursId === schedule.id)
                .map((group) => group.name)}
            />
            <HolidayList
              scheduleId={schedule.id}
              holidays={allHolidays.filter((holiday) => holiday.businessHoursId === schedule.id)}
            />
          </Card>
        ))}
      </div>

      {schedules.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          No schedules yet, so nothing counts as out-of-hours: every target is counted in real time
          and reporting measures overnight silence as response time.
        </p>
      ) : null}
    </>
  );
}
