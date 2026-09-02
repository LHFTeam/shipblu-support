import { and, eq, sql } from 'drizzle-orm';
import { SEEDED_RULES } from '@/lib/automations/defaults';
import { syncTaxonomy } from '@/lib/categorise/seed';
import { closeDb, db } from './client';
import { automationRules, businessHours, channels, groups, ticketStatuses } from './schema';
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

  // The customer bot's number.
  //
  // Seeded rather than left to the admin screen because the row is what routes
  // an inbound event to the read-only channel. Until it exists, messages from
  // this number arrive as ordinary WhatsApp tickets that the team can reply to —
  // straight into a conversation the bot is running. The name is the conflict
  // target, so re-running this never makes a second one.
  const bot = await db
    .insert(channels)
    .values({
      type: 'whatsapp_bot',
      name: 'WhatsApp Customer Bot',
      config: { phoneNumberId: '128318316834446' },
    })
    .onConflictDoNothing({ target: channels.name })
    .returning({ id: channels.id });

  console.log(bot.length ? '  customer bot channel: created' : '  customer bot channel: present');

  // The rules that decide when a ticket stops being the customer's to reply to.
  //
  // Guarded by a lookup rather than `onConflictDoNothing`, because unlike
  // statuses, groups and channels this table has no unique index on `name` —
  // and adding one to make the seed tidier would be a migration that locks a
  // table for the sake of an insert that runs once. An admin who edits or
  // deactivates one of these keeps their version: the name is the identity, so
  // re-running finds it and leaves it alone.
  let rulesCreated = 0;
  for (const rule of SEEDED_RULES) {
    const existing = await db
      .select({ id: automationRules.id })
      .from(automationRules)
      .where(and(eq(automationRules.name, rule.name), eq(automationRules.trigger, rule.trigger)))
      .limit(1);

    if (existing.length) continue;

    await db.insert(automationRules).values(rule);
    rulesCreated += 1;
  }

  console.log(
    `  automation rules: ${rulesCreated} created, ${SEEDED_RULES.length - rulesCreated} already present`,
  );

  // The category and root-cause registries. A reconcile rather than an
  // overwrite: labels an admin has edited are left alone, and a category dropped
  // from the code is reported rather than deleted, because the FK is `restrict`
  // and there may be tickets behind it.
  const taxonomy = await syncTaxonomy();
  console.log(
    `  ticket categories: ${taxonomy.categoriesCreated} created, ${taxonomy.categoriesPresent} already present`,
  );
  console.log(
    `  root causes: ${taxonomy.causesCreated} created, ${taxonomy.causesPresent} already present`,
  );
  if (taxonomy.orphanedCategoryKeys.length || taxonomy.orphanedCauseKeys.length) {
    console.log(
      `  in the database but no longer in the code (left alone, decide by hand): ${[
        ...taxonomy.orphanedCategoryKeys,
        ...taxonomy.orphanedCauseKeys,
      ].join(', ')}`,
    );
  }

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
