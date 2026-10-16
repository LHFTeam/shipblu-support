import { asc, eq } from 'drizzle-orm';
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

/** The rule a ticket's survey uses, and its strings for the customer's language. */
export async function wordingForTicket(
  scope: { groupId: string | null; channel: string },
  locale: WordingLocale,
): Promise<{ ruleId: string | null; wording: Wording }> {
  const rule = pickWordingRule(await listWordingRules(), scope);
  return { ruleId: rule?.id ?? null, wording: resolveWording(rule, locale) };
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
