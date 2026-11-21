import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { csatRules } from '@/db/schema';
import {
  pickWordingRule,
  resolveWording,
  type Wording,
  type WordingLocale,
  type WordingPair,
} from './wording';

/**
 * The wording rules as rows, and the one answer the job and the page need
 * from them: what a given survey says. The pure half — limits, fallback,
 * which rule wins — is `wording.ts`; this is the reading.
 */

export type WordingRule = WordingPair & {
  id: string;
  groupId: string | null;
  channel: string | null;
  isActive: boolean;
  updatedAt: Date;
};

/** Every rule, oldest first, for the admin page. */
export async function listWordingRules(): Promise<WordingRule[]> {
  return db.select().from(csatRules).orderBy(asc(csatRules.createdAt));
}

/**
 * The rule a ticket's survey goes out under, or null for the built-in wording:
 * the row records it, and whatever words the survey later — its page, the
 * widget's card, the app's route — words it from that rule. A survey sent
 * with a body words it now, through `resolveWording`; one the app pulls is
 * worded when the app asks (`lib/api/survey.ts`), so it needs only this.
 */
export async function wordingRuleForTicket(scope: {
  groupId: string | null;
  channel: string;
}): Promise<WordingRule | null> {
  return pickWordingRule(await listWordingRules(), scope);
}

/**
 * The strings a survey's page shows, from the rule it went out with. A rule
 * since deleted, or none, is the built-in wording the rule was a variation
 * of — the page still asks a question rather than nothing.
 */
export async function wordingForRule(
  ruleId: string | null,
  locale: WordingLocale,
): Promise<Wording> {
  if (!ruleId) return resolveWording(null, locale);
  const rows = await db.select().from(csatRules).where(eq(csatRules.id, ruleId)).limit(1);
  return resolveWording(rows[0] ?? null, locale);
}

/**
 * Several rules by id in one statement, for a reader holding more than one
 * survey: the widget's transcript is re-read on every message, and a read per
 * survey there is a read per survey on every push to every open widget.
 */
export async function wordingRulesById(ids: string[]): Promise<Map<string, WordingRule>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(csatRules).where(inArray(csatRules.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}
