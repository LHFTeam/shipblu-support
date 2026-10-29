import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, automationRules, channels } from '@/db/schema';
import { parseAction } from '@/lib/automations/actions';
import type { CategoryAiMode } from '@/lib/category-ai/modes';
import { readCategoryAiSettings } from '@/lib/category-ai/settings';
import { listCategories, type CategoryRow } from '@/lib/categories/queries';
import { routeGroupSummaries, type RouteGroupSummary } from '@/lib/categories/route-groups';
import { isWithinBusinessHours, nextOpeningAt } from '@/lib/hours';
import { loadHoursCatalog } from '@/lib/hours/catalog';
import { groupHours, type HoursCatalog } from '@/lib/hours/resolve';
import { evaluate, parseCondition, type Condition, type Facts } from '@/lib/rules/conditions';
import {
  isCommentChannel,
  isMetaChannel,
  metaPlatformOf,
  type ConversationChannel,
} from '@/lib/tickets/channel-policy';
import { typesafeConfigured } from '@/lib/typesafe/client';
import { filesRoutableTickets, filingRowFor, ownedByActiveAgent } from './filing';
import { routingModeOf, routingStartFor, type RoutingMode, type RoutingStart } from './mode';
import { routingLock, type RoutingLock } from './mode-copy';

/**
 * What `/admin/channels` says before an admin moves a channel off its default
 * group, and while one is off it: per category, where its tickets go and
 * whether anybody there would be assigned one; per channel, everything that
 * would leave the mode doing nothing, or leave routed tickets unassigned
 * (`plans/ticket-category-routing.md`, Stage 5.1, "a readiness panel").
 *
 * Nothing here is refused. A team that picks its own tickets from a queue is
 * a real choice, and so is a rule that files web chat by hand; the panel's job
 * is that the choice is made knowing what it does, because once a channel
 * routes, a ticket landing in a group nobody is assigned from is found by a
 * breach report rather than by a person.
 *
 * Every fact is the one the code acting on it reads, never a second reading
 * of it: the mode through `routingModeOf`, whether routing starts through
 * `routingStartFor`, who is accepting through `routeGroupSummaries` (which is
 * `filterCandidates`, assignment's own test), and a group's hours through
 * `groupHours` and `isWithinBusinessHours`, as assignment's hours gate asks
 * them. A panel that reasoned on its own would agree with the router until
 * the day one of them changed.
 */

/** A group as a routed ticket would meet it at `now`. */
export type GroupFacts = RouteGroupSummary & {
  /** The calendar assignment reads for it: its own, the default schedule, or none at all. */
  hours: 'own' | 'default' | 'none';
  /** True when there is no schedule anywhere, as assignment reads it. */
  openNow: boolean;
  /** When it next opens, if it is shut now. */
  opensAt: Date | null;
};

/**
 * What would leave a ticket in a group unassigned. `manual` and `unstaffed`
 * are configuration; `nobody_accepting` and `closed` are facts about `now`,
 * which the panel says in those words.
 */
export type GroupGap = 'manual' | 'unstaffed' | 'nobody_accepting' | 'closed';

export type CategoryReadiness = {
  id: string;
  key: string;
  labelEn: string;
  /** Null for a category with no route group: its tickets stay in their channel's default group. */
  routeGroup: GroupFacts | null;
  gaps: GroupGap[];
};

/**
 * An active rule that can decide a held ticket before the router does, by an
 * action that ends the hold (`endHold`'s `rule` callers in
 * `lib/automations/index.ts`): `assign_agent` naming somebody, `assign_group`
 * moving the ticket, and `auto_assign` naming another group.
 */
export type HoldEndingRule = {
  id: string;
  name: string;
  trigger: 'on_create' | 'on_update' | 'time_based';
  action: 'assign_agent' | 'assign_group' | 'auto_assign';
  /** The group a group action names; null for `assign_agent`, and for `assign_group` to none. */
  groupName: string | null;
  /**
   * Whether it matches every ticket the channel files, as far as the channel
   * and a held ticket's own state can tell — rather than only some, which
   * depends on what a ticket says.
   */
  everyTicket: boolean;
};

export type ChannelWarning =
  /** The column names a category mode the router never acts on. */
  | { kind: 'never_routes'; reason: RoutingLock }
  | { kind: 'inactive' }
  /** Another row of its type is the one new tickets are filed under. */
  | { kind: 'not_filing_row'; filingRow: string }
  /** An owned number's tickets are its owner's from the insert, and never held. */
  | { kind: 'owned'; owner: string }
  | { kind: 'classifier_idle'; classifier: CategoryAiMode }
  /** In `apply` with no key, so nothing is asked and every window ends in `fallback`. */
  | { kind: 'no_key' }
  | { kind: 'no_route_group'; categories: string[] }
  | { kind: 'route_gaps'; categories: { label: string; group: string; gaps: GroupGap[] }[] }
  /** Where a ticket that settles no category, or one with no route group, stays. */
  | { kind: 'default_group'; group: GroupFacts | null; gaps: GroupGap[] }
  | { kind: 'rules'; rules: HoldEndingRule[] };

export type ChannelRouting = {
  id: string;
  name: string;
  type: ConversationChannel;
  isActive: boolean;
  /** As saved — what the channel forms show. */
  column: RoutingMode;
  /** What the router acts on (`routingModeOf`). */
  mode: RoutingMode;
  /** What a new ticket on it gets now: a hold, a record, or nothing. */
  starts: RoutingStart | null;
  /** Empty for a row on `default_group`: there is nothing to warn about. */
  warnings: ChannelWarning[];
};

export type RoutingReadiness = {
  classifier: { mode: CategoryAiMode; keyConfigured: boolean; windowMinutes: number };
  /** The active categories, in the admin's order. */
  categories: CategoryReadiness[];
  /** Every channel, oldest first — the forms read each row's saved mode from here. */
  channels: ChannelRouting[];
};

/**
 * Everything the panel draws, as of `now`.
 *
 * One query at a time: the page runs this in one of the three lanes it reads
 * through (§6.91), and the hours catalog alone is three queries at once. Eight
 * statements in all, the catalog's memo and `listCategories`' request cache
 * saving some of them on a warm render.
 *
 * The classifier's switch is read uncached, as `/admin/categories` reads it:
 * the panel answers "is this channel routing?" after a save on that page, and
 * the memo would answer it as of thirty seconds ago.
 */
export async function routingReadiness(now: Date = new Date()): Promise<RoutingReadiness> {
  const settings = await readCategoryAiSettings();
  const categories = await listCategories();
  const groups = await routeGroupSummaries(now);
  const catalog = await loadHoursCatalog();
  const channelRows = await readChannels();
  const rules = await readHoldRules();

  return assessReadiness({
    classifier: {
      mode: settings.mode,
      keyConfigured: typesafeConfigured(),
      windowMinutes: settings.routingWindowMinutes,
    },
    categories,
    groups,
    catalog,
    channels: channelRows,
    rules,
    now,
  });
}

type ChannelInput = {
  id: string;
  type: ConversationChannel;
  name: string;
  config: Record<string, unknown>;
  routingMode: RoutingMode;
  isActive: boolean;
  createdAt: Date;
  defaultGroupId: string | null;
  ownerName: string | null;
  ownerActive: boolean | null;
};

type RuleInput = {
  id: string;
  name: string;
  trigger: HoldEndingRule['trigger'];
  conditions: unknown;
  actions: unknown[];
};

/**
 * Oldest first, ties by id — the order every ingest path picks "the row of
 * this type" by (`defaultEmailChannel`, `channelFor`, `webchatChannel`), so
 * "is this the row tickets are filed under?" is answered the way they answer
 * it. The owner by a join rather than through `numberOwnership`, which reads
 * every number's history beside it.
 */
function readChannels(): Promise<ChannelInput[]> {
  return db
    .select({
      id: channels.id,
      type: channels.type,
      name: channels.name,
      config: channels.config,
      routingMode: channels.routingMode,
      isActive: channels.isActive,
      createdAt: channels.createdAt,
      defaultGroupId: channels.defaultGroupId,
      // The owner's name, or their email where the name is blank, as every
      // other place the console names an agent: the warning keyed on owning
      // must have somebody to name.
      ownerName: sql<string | null>`coalesce(nullif(${agents.name}, ''), ${agents.email})`,
      ownerActive: agents.isActive,
    })
    .from(channels)
    .leftJoin(agents, eq(agents.id, channels.ownerAgentId))
    .orderBy(asc(channels.createdAt), asc(channels.id));
}

/** Every active rule of a trigger that runs while a ticket is held, in the engine's order. */
function readHoldRules(): Promise<RuleInput[]> {
  return db
    .select({
      id: automationRules.id,
      name: automationRules.name,
      trigger: automationRules.trigger,
      conditions: automationRules.conditions,
      actions: automationRules.actions,
    })
    .from(automationRules)
    .where(
      and(
        eq(automationRules.isActive, true),
        inArray(automationRules.trigger, ['on_create', 'on_update', 'time_based']),
      ),
    )
    .orderBy(asc(automationRules.trigger), asc(automationRules.position), asc(automationRules.id));
}

/** The reads, judged: pure from here, with one clock for every fact about now. */
function assessReadiness(input: {
  classifier: RoutingReadiness['classifier'];
  categories: CategoryRow[];
  groups: RouteGroupSummary[];
  catalog: HoursCatalog;
  channels: ChannelInput[];
  rules: RuleInput[];
  now: Date;
}): RoutingReadiness {
  const { classifier, catalog, now } = input;
  const groupsById = new Map(input.groups.map((group) => [group.id, group]));
  const facts = (groupId: string | null): GroupFacts | null => {
    const group = groupId ? groupsById.get(groupId) : undefined;
    return group ? groupFacts(group, catalog, now) : null;
  };

  const categories: CategoryReadiness[] = input.categories
    .filter((category) => category.isActive)
    .map((category) => {
      const routeGroup = facts(category.routeGroupId);
      return {
        id: category.id,
        key: category.key,
        labelEn: category.labelEn,
        routeGroup,
        gaps: routeGroup ? groupGaps(routeGroup) : [],
      };
    });

  const routingChannels = input.channels.map((channel): ChannelRouting => {
    const mode = routingModeOf(channel);
    const filingRow = filingRowFor(channel, input.channels);
    const owned = ownedByActiveAgent(channel) ? (channel.ownerName ?? 'its owner') : null;
    const files = filesRoutableTickets(channel, input.channels);
    const starts = files ? routingStartFor(mode, classifier.mode) : null;
    const base = {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      isActive: channel.isActive,
      column: channel.routingMode,
      mode,
      starts,
    };
    if (channel.routingMode === 'default_group') return { ...base, warnings: [] };

    const warnings: ChannelWarning[] = [];
    const lock = routingLock(channel);
    if (lock) {
      warnings.push({ kind: 'never_routes', reason: lock });
      return { ...base, warnings };
    }
    if (!channel.isActive) warnings.push({ kind: 'inactive' });
    else if (filingRow && filingRow !== channel) {
      warnings.push({ kind: 'not_filing_row', filingRow: filingRow.name });
    }
    if (owned !== null) warnings.push({ kind: 'owned', owner: owned });
    if (classifier.mode !== 'apply') {
      warnings.push({ kind: 'classifier_idle', classifier: classifier.mode });
    } else if (!classifier.keyConfigured) {
      warnings.push({ kind: 'no_key' });
    }

    const unrouted = categories.filter((category) => !category.routeGroup);
    if (unrouted.length > 0) {
      warnings.push({
        kind: 'no_route_group',
        categories: unrouted.map((category) => category.labelEn),
      });
    }
    // A route group that is the channel's own default group is where those
    // tickets stay, and is judged as that below rather than twice.
    const gapped = categories.filter(
      (category) =>
        category.routeGroup &&
        category.routeGroup.id !== channel.defaultGroupId &&
        category.gaps.length > 0,
    );
    if (gapped.length > 0) {
      warnings.push({
        kind: 'route_gaps',
        categories: gapped.map((category) => ({
          label: category.labelEn,
          group: category.routeGroup!.name,
          gaps: category.gaps,
        })),
      });
    }
    const home = facts(channel.defaultGroupId);
    const homeGaps = home ? groupGaps(home) : [];
    if (!home || homeGaps.length > 0) {
      warnings.push({ kind: 'default_group', group: home, gaps: homeGaps });
    }

    const rules = holdEndingRules(
      input.rules,
      filedChannels(channel, input.channels),
      channel.defaultGroupId,
      groupsById,
    );
    if (rules.length > 0) warnings.push({ kind: 'rules', rules });

    return { ...base, warnings };
  });

  return { classifier, categories, channels: routingChannels };
}

function groupFacts(group: RouteGroupSummary, catalog: HoursCatalog, now: Date): GroupFacts {
  const config = groupHours(catalog, group.id);
  // No schedule anywhere means nobody has said when this team works, which
  // assignment reads as open — so does this.
  const openNow = config ? isWithinBusinessHours(config, now) : true;
  return {
    ...group,
    hours: !config ? 'none' : catalog.overrides.has(group.id) ? 'own' : 'default',
    openNow,
    opensAt: config && !openNow ? nextOpeningAt(config, now) : null,
  };
}

/**
 * Assignment's own refusals, in its order (`assignConversation`): a manual
 * group assigns nobody and nothing after it matters, a group of nobody has
 * nobody to pick, and the two facts about now — nobody accepting, and shut
 * while it assigns only within its hours — each leave the ticket waiting.
 */
function groupGaps(group: GroupFacts): GroupGap[] {
  if (group.strategy === 'manual') return ['manual'];
  if (group.members === 0) return ['unstaffed'];
  const gaps: GroupGap[] = [];
  if (group.acceptingNow === 0) gaps.push('nobody_accepting');
  if (group.assignWithinHoursOnly && !group.openNow) gaps.push('closed');
  return gaps;
}

/**
 * The ticket channels a row files: its own type, and for a Meta platform's
 * row, its comments too while no comments row is active (`channelFor` in
 * `lib/tickets/ingest-meta.ts`), which a rule matching on `channel` tells
 * apart.
 */
function filedChannels(channel: ChannelInput, rows: ChannelInput[]): ConversationChannel[] {
  if (!isMetaChannel(channel.type) || isCommentChannel(channel.type)) return [channel.type];
  const comments =
    metaPlatformOf(channel.type) === 'facebook' ? 'facebook_comment' : 'instagram_comment';
  return rows.some((row) => row.type === comments && row.isActive)
    ? [channel.type]
    : [channel.type, comments];
}

function holdEndingRules(
  rules: RuleInput[],
  filed: ConversationChannel[],
  defaultGroupId: string | null,
  groups: Map<string, RouteGroupSummary>,
): HoldEndingRule[] {
  const found: HoldEndingRule[] = [];
  for (const rule of rules) {
    const condition = parseCondition(rule.conditions);
    // A malformed condition never matches (`matches`), so it ends nothing.
    if (!condition) continue;
    const answers = filed.map((channel) => onHeldTicket(condition, heldFacts(channel)));
    if (answers.every((answer) => answer === false)) continue;

    const action = holdEndingAction(rule.actions, defaultGroupId, groups);
    if (!action) continue;
    found.push({
      id: rule.id,
      name: rule.name,
      trigger: rule.trigger,
      action: action.type,
      groupName: action.groupId ? (groups.get(action.groupId)?.name ?? null) : null,
      everyTicket: answers.every((answer) => answer === true),
    });
  }
  return found;
}

/**
 * What is known of every held ticket a channel files, whatever it says: its
 * channel, and that nobody holds it and it is not spam — a held ticket is
 * unassigned by definition, and spam never enters routing. Everything else
 * depends on the ticket.
 */
function heldFacts(channel: ConversationChannel): Facts {
  return { channel, is_assigned: false, 'assignee.id': null, is_spam: false };
}

/**
 * A condition asked of what is known: true when it holds whatever else the
 * ticket says, false when it cannot, and null when that depends on the rest.
 * `evaluate` answers each comparison it has a fact for, so the language is
 * read here exactly as the engine reads it.
 */
function onHeldTicket(condition: Condition, known: Facts): boolean | null {
  if ('all' in condition) {
    let answer: boolean | null = true;
    for (const branch of condition.all) {
      const part = onHeldTicket(branch, known);
      if (part === false) return false;
      if (part === null) answer = null;
    }
    return answer;
  }
  if ('any' in condition) {
    let answer: boolean | null = false;
    for (const branch of condition.any) {
      const part = onHeldTicket(branch, known);
      if (part === true) return true;
      if (part === null) answer = null;
    }
    return answer;
  }
  if ('not' in condition) {
    const part = onHeldTicket(condition.not, known);
    return part === null ? null : !part;
  }
  if (!('field' in condition)) return true;
  return condition.field in known ? evaluate(condition, known) : null;
}

/**
 * The first of a rule's actions that would end a hold on a ticket that starts
 * in the channel's default group. A group action naming that group moves
 * nothing there (`moveToGroupIfElsewhere`), and an `auto_assign` with no group
 * assigns within the current one, which is held like any other assignment.
 * Nor does one naming a group deleted since: it moves nothing either, its
 * action failing on the foreign key or skipped as gone.
 */
function holdEndingAction(
  actions: unknown[],
  defaultGroupId: string | null,
  groups: Map<string, RouteGroupSummary>,
): { type: HoldEndingRule['action']; groupId: string | null } | null {
  const moves = (groupId: string | null) =>
    groupId !== defaultGroupId && (groupId === null || groups.has(groupId));
  for (const raw of actions) {
    const action = parseAction(raw);
    if (!action) continue;
    if (action.type === 'assign_agent' && action.agentId) {
      return { type: 'assign_agent', groupId: null };
    }
    if (action.type === 'assign_group' && moves(action.groupId)) {
      return { type: 'assign_group', groupId: action.groupId };
    }
    if (action.type === 'auto_assign' && action.groupId && moves(action.groupId)) {
      return { type: 'auto_assign', groupId: action.groupId };
    }
  }
  return null;
}
