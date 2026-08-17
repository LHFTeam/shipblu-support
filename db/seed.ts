import { sql } from 'drizzle-orm';
import { closeDb, db } from './client';
import { businessHours, groups, ticketStatuses } from './schema';
import type { WeeklySchedule } from './schema/config';

/**
 * Baseline configuration the app cannot function without.
 *
 * Idempotent: every insert is onConflictDoNothing keyed on a natural unique
 * column, so this is safe to re-run after every deploy.
 */

/** Sunday–Thursday is the Egyptian working week. */
const CAIRO_WEEK: WeeklySchedule = {
  sun: [{ start: '09:00', end: '17:00' }],
  mon: [{ start: '09:00', end: '17:00' }],
  tue: [{ start: '09:00', end: '17:00' }],
  wed: [{ start: '09:00', end: '17:00' }],
  thu: [{ start: '09:00', end: '17:00' }],
  fri: [],
  sat: [],
};

/**
 * Mirrors Freshdesk's defaults so the team's existing workflow and reports carry
 * over without relearning anything.
 *
 * `stopsSlaClock` on Pending is the important one: time spent waiting on the
 * customer must not count against our resolution target.
 */
const STATUSES = [
  { name: 'Open', category: 'open' as const, stopsSlaClock: false, isDefault: true, position: 1 },
  {
    name: 'Pending',
    category: 'pending' as const,
    stopsSlaClock: true,
    isDefault: false,
    position: 2,
  },
  {
    name: 'Resolved',
    category: 'resolved' as const,
    stopsSlaClock: true,
    isDefault: false,
    position: 3,
  },
  {
    name: 'Closed',
    category: 'closed' as const,
    stopsSlaClock: true,
    isDefault: false,
    position: 4,
  },
];

async function main() {
  console.log('Seeding baseline configuration...');

  const hours = await db
    .insert(businessHours)
    .values({
      name: 'Default (Cairo)',
      timezone: 'Africa/Cairo',
      schedule: CAIRO_WEEK,
      isDefault: true,
    })
    .onConflictDoNothing({ target: businessHours.name })
    .returning({ id: businessHours.id });

  console.log(hours.length ? '  business hours: created' : '  business hours: already present');

  let created = 0;
  for (const status of STATUSES) {
    const result = await db
      .insert(ticketStatuses)
      .values({ ...status, isSystem: true })
      .onConflictDoNothing({ target: ticketStatuses.name })
      .returning({ id: ticketStatuses.id });
    created += result.length;
  }
  console.log(
    `  ticket statuses: ${created} created, ${STATUSES.length - created} already present`,
  );

  const group = await db
    .insert(groups)
    .values({ name: 'Support', description: 'Default group for incoming tickets' })
    .onConflictDoNothing({ target: groups.name })
    .returning({ id: groups.id });

  console.log(group.length ? '  group: created' : '  group: already present');

  const counts = await db.execute<{ statuses: number }>(
    sql`select count(*)::int as statuses from ticket_statuses`,
  );
  console.log('Done.', counts);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
