import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { businessHours, holidays } from '@/db/schema';
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
 */
export default async function HoursPage() {
  await requirePermission('admin.sla');

  const schedules = await db.select().from(businessHours).orderBy(asc(businessHours.name));

  const allHolidays = await db.select().from(holidays).orderBy(asc(holidays.date));

  void eq;

  return (
    <>
      <PageHeader
        title="Business hours"
        description="SLA targets are counted in working time. A schedule decides which hours count and which are the office being shut."
        actions={<NewSchedule />}
      />

      <div className="flex flex-col gap-4">
        {schedules.map((schedule) => (
          <Card key={schedule.id}>
            <HoursEditor schedule={schedule} />
            <HolidayList
              scheduleId={schedule.id}
              holidays={allHolidays.filter((holiday) => holiday.businessHoursId === schedule.id)}
            />
          </Card>
        ))}
      </div>

      {schedules.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          No schedules yet. SLA policies without one count time around the clock.
        </p>
      ) : null}
    </>
  );
}
