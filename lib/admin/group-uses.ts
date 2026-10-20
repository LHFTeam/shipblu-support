import { alias } from 'drizzle-orm/pg-core';
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  notExists,
  or,
  sql,
  type AnyColumn,
} from 'drizzle-orm';
import { db } from '@/db/client';
import {
  automationRules,
  cannedResponses,
  channels,
  conversations,
  groups,
  skills,
  slaPolicies,
  ticketForms,
  whatsappAccounts,
  whatsappOnboardings,
} from '@/db/schema';
import { formName } from '@/lib/forms/naming';
import { storedCredentialExists } from '@/lib/whatsapp/credentials';
import { SUPERSEDED } from '@/lib/whatsapp/onboarding';
import { SHOW_FAILED_FOR_MS } from '@/lib/whatsapp/onboarding-view';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * What still points at a group and would quietly stop working without it, for
 * the refusal to delete it.
 *
 * The foreign keys from a channel's and a form's default group are
 * `on delete set null`, so the database itself would let the group go and
 * quietly empty them — and from then on every ticket arriving on that channel
 * is inserted with no group, which `assignConversation` answers with
 * `no_group` without a word on the timeline, the sweep never retries (it joins
 * `groups`), and no inbox view gathers it: a group view filters on one group's
 * id, and an agent without `ticket.view.all` reaches a ticket only through its
 * assignee or its group. So the deletion is refused instead, naming what to
 * move first, the same way it already refuses while tickets carry the group.
 *
 * Automation rules, SLA policies and skills hold groups inside jsonb, where no
 * foreign key can see them. A rule whose action names a deleted group fails its
 * update on the foreign key; a condition naming one — a rule's, a policy's or
 * the requirement a skill puts on a ticket — never matches again. Each is a
 * routing decision going missing without anybody being told, so they count.
 *
 * Canned responses shared with the group are `on delete cascade`: the delete
 * takes them, text and all. One an automation rule sends counts, because the
 * rule would go on matching and quietly send nothing (`sendCannedReply` logs a
 * line and returns). One no rule sends goes with the team, as it would if an
 * admin deleted it by hand. Auto-responses and CSAT rules scoped to the group
 * cascade too and are left to: each only narrows a broader row, which answers
 * in its place.
 *
 * A WhatsApp onboarding that has not reached its `channel` step names the
 * default group the channel it will create should start in, and deleting the
 * group would create that channel with none. Only an attempt that can still get
 * there without anybody going back through Meta's window counts: one running
 * now, and a failed one the Channels page still offers to retry — it holds a
 * stored credential, failed within `SHOW_FAILED_FOR_MS`, was neither retired as
 * superseded nor replaced by a newer attempt on its number. Counting every
 * failed attempt instead made one abandoned months ago block the group for
 * good, with nothing on the page left to press. An attempt whose number already
 * has a channel is a reconnect, which keeps that channel's own group, so it
 * never counts.
 */
export type GroupUses = {
  tickets: number;
  channels: string[];
  forms: string[];
  /** Attempts running now, and failed ones the Channels page offers to retry. */
  onboardings: { connecting: number; retryable: number };
  automationRules: string[];
  slaPolicies: string[];
  skills: string[];
  /** Shared with the group, and sent by an automation rule. */
  cannedResponses: string[];
};

export async function groupUses(
  groupId: string,
  on: typeof db | Tx = db,
  now: Date = new Date(),
): Promise<GroupUses> {
  // A jsonb document names a group by its uuid as a string, so finding the
  // string in the document's text is exact: a uuid cannot occur by accident
  // inside another value. One read each, in turn — this runs on an admin's
  // click, and eight reads at once would take every one of the pool's eight
  // places for a question nobody is waiting on.
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
  const failedSince = new Date(now.getTime() - SHOW_FAILED_FOR_MS).toISOString();
  const onboardingRows = await on
    .select({ status: whatsappOnboardings.status, count: sql<number>`count(*)::int` })
    .from(whatsappOnboardings)
    // Inner: an attempt whose account is gone has no credential to retry with.
    .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, whatsappOnboardings.whatsappAccountId))
    .where(
      and(
        eq(whatsappOnboardings.defaultGroupId, groupId),
        isNull(whatsappOnboardings.channelId),
        or(
          eq(whatsappOnboardings.status, 'exchanged'),
          and(
            eq(whatsappOnboardings.status, 'failed'),
            sql`${whatsappOnboardings.error} is distinct from ${SUPERSEDED}`,
            storedCredentialExists(),
            sql`coalesce(${whatsappOnboardings.finishedAt}, ${whatsappOnboardings.startedAt}) >= ${failedSince}::timestamptz`,
          ),
        ),
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
        notExists(
          on
            .select({ one: sql`1` })
            .from(channels)
            .where(
              and(
                inArray(channels.type, ['whatsapp', 'whatsapp_bot']),
                sql`${channels.config} ->> 'phoneNumberId' = ${whatsappOnboardings.phoneNumberId}`,
              ),
            ),
        ),
      ),
    )
    .groupBy(whatsappOnboardings.status);
  const attempts = (status: string) =>
    onboardingRows.find((row) => row.status === status)?.count ?? 0;

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

  const cannedRows = await on
    .select({ title: cannedResponses.title })
    .from(cannedResponses)
    .where(
      and(
        eq(cannedResponses.visibility, 'group'),
        eq(cannedResponses.groupId, groupId),
        exists(
          on
            .select({ one: sql`1` })
            .from(automationRules)
            .where(
              sql`position(${cannedResponses.id}::text in ${automationRules.actions}::text) > 0`,
            ),
        ),
      ),
    )
    .orderBy(asc(cannedResponses.title));

  return {
    tickets: ticketCount?.count ?? 0,
    channels: channelRows.map((row) => row.name),
    forms: formRows.map((row) => formName(row, 'en')),
    onboardings: { connecting: attempts('exchanged'), retryable: attempts('failed') },
    automationRules: ruleRows.map((row) => row.name),
    slaPolicies: policyRows.map((row) => row.name),
    skills: skillRows.map((row) => row.name),
    cannedResponses: cannedRows.map((row) => row.title),
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
  const { connecting, retryable } = uses.onboardings;
  if (connecting > 0) {
    parts.push(`the default for ${connecting} WhatsApp number(s) being connected now`);
  }
  if (retryable > 0) {
    parts.push(
      `the default for ${retryable} failed WhatsApp connection(s) that “Retry connection” would still finish`,
    );
  }
  if (uses.automationRules.length) {
    parts.push(`named by ${list('automation rule', uses.automationRules)}`);
  }
  if (uses.slaPolicies.length) parts.push(`named by ${list('SLA policy', uses.slaPolicies)}`);
  if (uses.skills.length) parts.push(`required by ${list('skill', uses.skills)}`);
  if (uses.cannedResponses.length) {
    parts.push(`shared with ${list('canned response', uses.cannedResponses)} that a rule sends`);
  }

  if (parts.length === 0) return null;
  // A failed attempt cannot be moved, only replaced or outlived, so it says how
  // it stops counting: connected again from the Channels page with another
  // group, or past `SHOW_FAILED_FOR_MS`, when the page stops offering Retry.
  const failed =
    retryable > 0
      ? ' A failed connection stops counting once its number is connected again with another group, or a week after it failed.'
      : '';
  return `That group is still in use: ${parts.join('; ')}. Move them to another group first.${failed}`;
}

function list(noun: string, names: string[]): string {
  const plural =
    names.length === 1 ? noun : noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${plural} ${names.map((name) => `“${name}”`).join(', ')}`;
}
