import { alias } from 'drizzle-orm/pg-core';
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  ne,
  not,
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
  ticketCategories,
  ticketForms,
  whatsappAccounts,
  whatsappOnboardings,
} from '@/db/schema';
import { categoryLabel } from '@/lib/categories/choices';
import { formName } from '@/lib/forms/naming';
import { storedCredentialExists } from '@/lib/whatsapp/credentials';
import { SUPERSEDED } from '@/lib/whatsapp/onboarding';
import {
  LIVE_ATTEMPT_MS,
  NUMBER_NOT_ON_ACCOUNT,
  SHOW_FAILED_FOR_MS,
  STALL_AFTER_MS,
} from '@/lib/whatsapp/onboarding-view';

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
 * A canned response naming the group (`group_id`, whatever its visibility says)
 * is `on delete cascade`: the delete takes it, text and all. One an automation
 * rule sends counts, because the rule would go on matching and quietly send
 * nothing (`sendCannedReply` logs a line and returns). One no rule sends goes
 * with the team, as it would if an admin deleted it by hand. Auto-responses and
 * CSAT rules scoped to the group cascade too and are left to: each only narrows
 * a broader row, which answers in its place. The group's slices of
 * `metrics_daily` cascade as well — a null group there means "every group", so
 * they cannot be kept under none — and the delete button says so before it is
 * pressed rather than refusing, since refusing would keep every group that ever
 * had a ticket for good.
 *
 * A WhatsApp onboarding that has not reached its `channel` step names the
 * default group the channel it will create should start in, and deleting the
 * group would create that channel with none. Only an attempt the Channels page
 * shows with a way to finish it counts, in the page's own terms
 * (`./onboarding-view`): one running now; one stalled, which `retryable()`
 * offers Retry for; and a failed one `recoveryFor` and `shownOnboardings` still
 * offer Retry for — its account holds a stored credential, it failed within
 * `SHOW_FAILED_FOR_MS`, it was neither retired as superseded nor replaced by a
 * newer attempt on its number, and it is not the wrong number picked in Meta's
 * window once the right one connected. Counting every failed attempt instead
 * made one abandoned months ago block the group for good, with nothing on the
 * page left to press. An attempt whose number already has a channel is a
 * reconnect, which keeps that channel's own group, so it never counts.
 */
export type GroupUses = {
  tickets: number;
  channels: string[];
  forms: string[];
  /** Attempts running, stalled, or failed and still offered Retry. */
  onboardings: { connecting: number; stalled: number; retryable: number };
  automationRules: string[];
  slaPolicies: string[];
  skills: string[];
  /** Naming the group, so deleted with it, and sent by an automation rule. */
  cannedResponses: string[];
  /**
   * Routing tickets to the group (`ticket_categories.route_group_id`), retired
   * ones too: retiring a category stops new tickets taking it, not the ones it
   * already holds being routed by it. The foreign key is `set null` like a
   * channel's, so without this the delete would quietly send that category's
   * tickets to their channel's default group.
   */
  categories: string[];
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

  // Live tickets only. A deleted or merged one is in no console list, so a
  // refusal counting it asked the admin to move what nobody can open, and the
  // group could never go; its `set null` foreign key empties it harmlessly.
  const [ticketCount] = await on
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(
      and(
        eq(conversations.groupId, groupId),
        isNull(conversations.deletedAt),
        isNull(conversations.mergedIntoId),
      ),
    );

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
  const sibling = alias(whatsappOnboardings, 'sibling');
  const failedSince = new Date(now.getTime() - SHOW_FAILED_FOR_MS).toISOString();
  const onboardingRows = await on
    .select({
      status: whatsappOnboardings.status,
      startedAt: whatsappOnboardings.startedAt,
      nextAttemptAt: whatsappOnboardings.nextAttemptAt,
    })
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
            // `shownOnboardings`: the wrong number picked in Meta's window is
            // hidden, Retry and all, once a later attempt on the same business
            // account connected — the right number picked the second time.
            not(
              and(
                // Never null, or `not` of an attempt with no number record
                // and a connected sibling would be null and drop it.
                sql`${whatsappOnboardings.steps} -> 'number' ->> 'outcome' is not distinct from ${NUMBER_NOT_ON_ACCOUNT}`,
                sql`${whatsappOnboardings.steps} -> 'number' ->> 'ok' is distinct from 'true'`,
                exists(
                  on
                    .select({ one: sql`1` })
                    .from(sibling)
                    .where(
                      and(
                        eq(sibling.wabaId, whatsappOnboardings.wabaId),
                        ne(sibling.id, whatsappOnboardings.id),
                        eq(sibling.status, 'connected'),
                        gt(sibling.startedAt, whatsappOnboardings.startedAt),
                      ),
                    ),
                ),
              )!,
            ),
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
    );
  // `retryable()`'s stall: past `LIVE_ATTEMPT_MS` with no retry due within
  // `STALL_AFTER_MS`. Nothing will move such an attempt but a Retry or a new
  // sign-in, so the refusal has to say so rather than call it "being connected".
  const stalled = (row: (typeof onboardingRows)[number]) =>
    now.getTime() - row.startedAt.getTime() > LIVE_ATTEMPT_MS &&
    !(row.nextAttemptAt && row.nextAttemptAt.getTime() >= now.getTime() - STALL_AFTER_MS);
  const exchanged = onboardingRows.filter((row) => row.status === 'exchanged');

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
        // The column the cascade follows, not the visibility: a response made
        // global by hand with its `group_id` left behind goes with the group too.
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

  const categoryRows = await on
    .select({ label: ticketCategories.labelEn, isActive: ticketCategories.isActive })
    .from(ticketCategories)
    .where(eq(ticketCategories.routeGroupId, groupId))
    .orderBy(asc(ticketCategories.position), asc(ticketCategories.key));

  return {
    tickets: ticketCount?.count ?? 0,
    channels: channelRows.map((row) => row.name),
    forms: formRows.map((row) => formName(row, 'en')),
    onboardings: {
      connecting: exchanged.filter((row) => !stalled(row)).length,
      stalled: exchanged.filter(stalled).length,
      retryable: onboardingRows.filter((row) => row.status === 'failed').length,
    },
    automationRules: ruleRows.map((row) => row.name),
    slaPolicies: policyRows.map((row) => row.name),
    skills: skillRows.map((row) => row.name),
    cannedResponses: cannedRows.map((row) => row.title),
    categories: categoryRows.map((row) => categoryLabel(row.label, row.isActive)),
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
  const { connecting, stalled, retryable } = uses.onboardings;
  if (connecting > 0) {
    parts.push(`the default for ${connecting} WhatsApp number(s) being connected now`);
  }
  if (stalled > 0) {
    parts.push(
      `the default for ${stalled} stalled WhatsApp connection(s) that “Retry connection” would finish`,
    );
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
    parts.push(`the group of ${list('canned response', uses.cannedResponses)} that a rule sends`);
  }
  if (uses.categories.length) {
    parts.push(`the route group of ${list('category', uses.categories)}`);
  }

  if (parts.length === 0) return null;
  // A stalled or failed attempt cannot be moved, only replaced — connected
  // again from the Channels page with another group — or, if it failed,
  // outlived: past `SHOW_FAILED_FOR_MS` the page stops offering Retry.
  const kind = stalled && retryable ? 'stalled or failed' : stalled ? 'stalled' : 'failed';
  const outlived = retryable
    ? `${stalled ? ', and a failed one' : ', or'} a week after it failed`
    : '';
  const failed =
    stalled || retryable
      ? ` A ${kind} connection stops counting once its number is connected again with another group${outlived}.`
      : '';
  return `That group is still in use: ${parts.join('; ')}. Move them to another group first.${failed}`;
}

function list(noun: string, names: string[]): string {
  const plural =
    names.length === 1 ? noun : noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${plural} ${names.map((name) => `“${name}”`).join(', ')}`;
}
