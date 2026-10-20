import { alias } from 'drizzle-orm/pg-core';
import { and, asc, eq, gt, isNull, ne, notExists, or, sql, type AnyColumn } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  automationRules,
  channels,
  conversations,
  groups,
  skills,
  slaPolicies,
  ticketForms,
  whatsappOnboardings,
} from '@/db/schema';
import { formName } from '@/lib/forms/naming';
import { SUPERSEDED } from '@/lib/whatsapp/onboarding';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What still points at a group and would quietly stop working without it, for
 * the refusal to delete it. Not everything that names one: a canned response's,
 * an auto-response's and a CSAT rule's group scope cascade with the group by
 * design, since each only narrows who it applies to and goes with the team.
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
 * Automation rules, SLA policies and skills hold groups inside jsonb, where no
 * foreign key can see them. A rule whose action names a deleted group fails its
 * update on the foreign key; a condition naming one — a rule's, a policy's or
 * the requirement a skill puts on a ticket — never matches again. Each is a
 * routing decision going missing without anybody being told, so they count.
 *
 * A WhatsApp onboarding that has not reached its `channel` step names the
 * default group the channel it will create should start in, and deleting the
 * group would create that channel with none. That is a live attempt, and also a
 * failed one "Retry connection" can still start again — every attempt not
 * connected, not retired as superseded and not replaced by a newer one on the
 * same number, which are the attempts `retryOnboarding` would accept.
 */
export type GroupUses = {
  tickets: number;
  channels: string[];
  forms: string[];
  onboardings: number;
  automationRules: string[];
  slaPolicies: string[];
  skills: string[];
};

export async function groupUses(groupId: string, on: typeof db | Tx = db): Promise<GroupUses> {
  // A jsonb document names a group by its uuid as a string, so finding the
  // string in the document's text is exact: a uuid cannot occur by accident
  // inside another value. One read each, in turn — this runs on an admin's
  // click, and six reads at once would take six of the pool's eight places for
  // a question nobody is waiting on.
  const mentions = (column: AnyColumn) => sql`position(${groupId} in ${column}::text) > 0`;

  const [ticketCount] = await on
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.groupId, groupId));

  const channelRows = await on
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.defaultGroupId, groupId))
    .orderBy(asc(channels.name));

  const formRows = await on
    .select({ nameAr: ticketForms.nameAr, nameEn: ticketForms.nameEn, slug: ticketForms.slug })
    .from(ticketForms)
    .where(eq(ticketForms.defaultGroupId, groupId))
    .orderBy(asc(ticketForms.slug));

  const newer = alias(whatsappOnboardings, 'newer');
  const [onboardingCount] = await on
    .select({ count: sql<number>`count(*)::int` })
    .from(whatsappOnboardings)
    .where(
      and(
        eq(whatsappOnboardings.defaultGroupId, groupId),
        isNull(whatsappOnboardings.channelId),
        ne(whatsappOnboardings.status, 'connected'),
        sql`${whatsappOnboardings.error} is distinct from ${SUPERSEDED}`,
        notExists(
          on
            .select({ one: sql`1` })
            .from(newer)
            .where(
              and(
                eq(newer.phoneNumberId, whatsappOnboardings.phoneNumberId),
                gt(newer.createdAt, whatsappOnboardings.createdAt),
              ),
            ),
        ),
      ),
    );

  const ruleRows = await on
    .select({ name: automationRules.name })
    .from(automationRules)
    .where(or(mentions(automationRules.actions), mentions(automationRules.conditions)))
    .orderBy(asc(automationRules.name));

  const policyRows = await on
    .select({ name: slaPolicies.name })
    .from(slaPolicies)
    .where(mentions(slaPolicies.conditions))
    .orderBy(asc(slaPolicies.name));

  const skillRows = await on
    .select({ name: skills.name })
    .from(skills)
    .where(mentions(skills.conditions))
    .orderBy(asc(skills.name));

  return {
    tickets: ticketCount?.count ?? 0,
    channels: channelRows.map((row) => row.name),
    forms: formRows.map((row) => formName(row, 'en')),
    onboardings: onboardingCount?.count ?? 0,
    automationRules: ruleRows.map((row) => row.name),
    slaPolicies: policyRows.map((row) => row.name),
    skills: skillRows.map((row) => row.name),
  };
}

/**
 * Deletes the group unless something still uses it, and answers the refusal
 * when something does — null once it is gone, or when it already was.
 *
 * One transaction, with the group's row locked before anything is counted. A
 * channel, form, ticket or onboarding that names the group takes a key-share
 * lock on that row as it is written, which waits for this one, so none can be
 * pointed at the group between the count and the delete — where, with the
 * foreign keys' `set null`, the delete would have emptied it without a word.
 * The jsonb holders take no such lock, so a rule saved in that same instant can
 * still name a group that is going; that window is a click wide and its result
 * is the one the editor's "Unknown:" choice already shows.
 */
export async function deleteGroupIfUnused(groupId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, groupId))
      .for('update');
    if (!locked) return null;

    const refusal = groupDeleteRefusal(await groupUses(groupId, tx));
    if (refusal) return refusal;

    await tx.delete(groups).where(eq(groups.id, groupId));
    return null;
  });
}

/**
 * The sentence the delete answers with, or null when nothing points at the
 * group. Every use is named, not counted, wherever it has a name: "move them
 * first" is only actionable if the admin knows which ones.
 */
function groupDeleteRefusal(uses: GroupUses): string | null {
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
  if (uses.skills.length) parts.push(`required by ${list('skill', uses.skills)}`);

  if (parts.length === 0) return null;
  return `That group is still in use: ${parts.join('; ')}. Move them to another group first.`;
}

function list(noun: string, names: string[]): string {
  const plural =
    names.length === 1 ? noun : noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${plural} ${names.map((name) => `“${name}”`).join(', ')}`;
}
