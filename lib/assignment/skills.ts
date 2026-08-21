import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { skills } from '@/db/schema';
import { matches, parseCondition } from '@/lib/rules/conditions';
import type { Facts } from '@/lib/rules/conditions';

/**
 * What a ticket needs somebody to be able to do.
 *
 * A skill is not stored on the ticket, it is *derived* from it, through the same
 * condition language as SLA policies and automation rules. The consequence worth
 * having: correcting a skill's conditions immediately corrects every ticket
 * sitting in the queue, rather than only the ones that arrive after the edit. A
 * skill column on the conversation would have frozen yesterday's mistake into
 * yesterday's tickets.
 */

export type SkillRow = { id: string; name: string; conditions: unknown };

/**
 * Which of these skills this ticket requires.
 *
 * **An empty condition set requires nothing.** This is the one place this
 * project reads `{}` as "never" rather than "always", and it is deliberate: for
 * an SLA policy the empty condition is the catch-all every configuration needs,
 * but a skill with no conditions is almost always one somebody started and did
 * not finish — and read as "always", it would demand a skill of every ticket in
 * the system and stop the queue dead. A skill genuinely required by everything
 * is expressible with a condition that says so.
 *
 * A malformed condition matches nothing, exactly as it does everywhere else that
 * reads this language, so a corrupt skill row cannot become the one that applies
 * to everything.
 */
export function matchingSkills(rows: SkillRow[], facts: Facts): string[] {
  const required: string[] = [];

  for (const row of rows) {
    const condition = parseCondition(row.conditions);
    if (!condition) continue;
    if (Object.keys(condition).length === 0) continue;
    if (matches(condition, facts)) required.push(row.id);
  }

  return required;
}

/** The database half: active skills, in the order the admin put them. */
export async function activeSkills(): Promise<SkillRow[]> {
  return db
    .select({ id: skills.id, name: skills.name, conditions: skills.conditions })
    .from(skills)
    .where(eq(skills.isActive, true))
    .orderBy(asc(skills.position), asc(skills.name));
}
