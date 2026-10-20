import { and, asc, eq, or, sql, type AnyColumn } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  automationRules,
  channels,
  conversations,
  slaPolicies,
  ticketForms,
  whatsappOnboardings,
} from '@/db/schema';
import { formName } from '@/lib/forms/naming';

/**
 * Everything that still points at a group, for the refusal to delete it.
 *
 * The foreign keys from a channel's and a form's default group are
 * `on delete set null`, so the database itself would let the group go and
 * quietly empty them — and from then on every ticket arriving on that channel
 * is inserted with no group, which `assignConversation` answers with
 * `no_group` without a word on the timeline, the sweep never retries (it joins
 * `groups`), and the inbox, which has no group filter, never shows. So the
 * deletion is refused instead, naming what to move first, the same way it
 * already refuses while tickets carry the group.
 *
 * Automation rules and SLA policies hold groups inside jsonb, where no foreign
 * key can see them. A rule whose action names a deleted group fails its update
 * on the foreign key; a condition naming one never matches again. Either is a
 * routing decision going missing without anybody being told, so they count.
 *
 * A WhatsApp onboarding still between exchange and its `channel` step names the
 * default group the channel it is about to create should start in; deleting the
 * group would create that channel with none.
 */
export type GroupUses = {
  tickets: number;
  channels: string[];
  forms: string[];
  onboardings: number;
  automationRules: string[];
  slaPolicies: string[];
};

export async function groupUses(groupId: string): Promise<GroupUses> {
  // A jsonb document names a group by its uuid as a string, so finding the
  // string in the document's text is exact: a uuid cannot occur by accident
  // inside another value. One read each, in turn — this runs on an admin's
  // click, and six reads at once would take six of the pool's eight places for
  // a question nobody is waiting on.
  const mentions = (column: AnyColumn) => sql`position(${groupId} in ${column}::text) > 0`;

  const [ticketCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.groupId, groupId));

  const channelRows = await db
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.defaultGroupId, groupId))
    .orderBy(asc(channels.name));

  const formRows = await db
    .select({ nameAr: ticketForms.nameAr, nameEn: ticketForms.nameEn, slug: ticketForms.slug })
    .from(ticketForms)
    .where(eq(ticketForms.defaultGroupId, groupId))
    .orderBy(asc(ticketForms.slug));

  const [onboardingCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(whatsappOnboardings)
    .where(
      and(
        eq(whatsappOnboardings.defaultGroupId, groupId),
        eq(whatsappOnboardings.status, 'exchanged'),
      ),
    );

  const ruleRows = await db
    .select({ name: automationRules.name })
    .from(automationRules)
    .where(or(mentions(automationRules.actions), mentions(automationRules.conditions)))
    .orderBy(asc(automationRules.name));

  const policyRows = await db
    .select({ name: slaPolicies.name })
    .from(slaPolicies)
    .where(mentions(slaPolicies.conditions))
    .orderBy(asc(slaPolicies.name));

  return {
    tickets: ticketCount?.count ?? 0,
    channels: channelRows.map((row) => row.name),
    forms: formRows.map((row) => formName(row, 'en')),
    onboardings: onboardingCount?.count ?? 0,
    automationRules: ruleRows.map((row) => row.name),
    slaPolicies: policyRows.map((row) => row.name),
  };
}

/**
 * The sentence the delete answers with, or null when nothing points at the
 * group. Every use is named, not counted, wherever it has a name: "move them
 * first" is only actionable if the admin knows which ones.
 */
export function groupDeleteRefusal(uses: GroupUses): string | null {
  const parts: string[] = [];
  if (uses.tickets > 0) parts.push(`${uses.tickets} ticket(s)`);
  if (uses.channels.length) parts.push(`the default for ${list('channel', uses.channels)}`);
  if (uses.forms.length) parts.push(`the default for ${list('form', uses.forms)}`);
  if (uses.onboardings > 0) {
    parts.push(`the default for ${uses.onboardings} WhatsApp number(s) still being connected`);
  }
  if (uses.automationRules.length) {
    parts.push(`named by ${list('automation rule', uses.automationRules)}`);
  }
  if (uses.slaPolicies.length) parts.push(`named by ${list('SLA policy', uses.slaPolicies)}`);

  if (parts.length === 0) return null;
  return `That group is still in use: ${parts.join('; ')}. Move them to another group first.`;
}

function list(noun: string, names: string[]): string {
  const plural =
    names.length === 1 ? noun : noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${plural} ${names.map((name) => `“${name}”`).join(', ')}`;
}
