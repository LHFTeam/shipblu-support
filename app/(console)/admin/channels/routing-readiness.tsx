import Link from 'next/link';
import { ChannelBadge } from '@/components/channel';
import { InfoTip } from '@/components/tooltip';
import { Badge, Notice, PageHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import {
  idleClassifierSentence,
  noKeyRoutingSentence,
  ROUTING_LOCK_REASONS,
  ROUTING_MODE_LABELS,
} from '@/lib/routing/mode-copy';
import type {
  CategoryReadiness,
  ChannelRouting,
  ChannelWarning,
  GroupFacts,
  GroupGap,
  HoldEndingRule,
  RoutingReadiness,
} from '@/lib/routing/readiness';
import { STRATEGY_LABELS } from '@/lib/assignment/strategy-copy';

/**
 * The readiness panel on `/admin/channels`: whether routing by category would
 * do what an admin expects of it, said before a channel leaves its default
 * group and for as long as one is off it (`lib/routing/readiness.ts`).
 *
 * On this page rather than on `/admin/categories`, beside the control that
 * switches a channel's routing — the decision the panel is there to inform —
 * with a link across to where a route group is fixed. The categories page
 * still badges a route group that would leave tickets unassigned while one is
 * being chosen.
 *
 * A server component: every fact is a sentence by the time it reaches the
 * browser, and the dates in it are written once, on the server.
 *
 * The panel says what will happen; `/reports/routing` says what did, so it
 * links there for anybody who may read the team's reports.
 */
export function RoutingReadinessPanel({
  readiness,
  canEditCategories,
  canViewReport,
}: {
  readiness: RoutingReadiness;
  canEditCategories: boolean;
  /**
   * `report.view`, which every admin holds: the link to the routing report.
   * Required, like the permission beside it: a default of `false` let the one
   * page that draws the panel leave it out, and the link was never shown.
   */
  canViewReport: boolean;
}) {
  const routing = readiness.channels.filter((channel) => channel.column !== 'default_group');
  const { classifier } = readiness;

  return (
    <section>
      <PageHeader
        title="Routing by category"
        description="Where each category’s tickets go, and what would stop a channel routing them, as of when this page loaded."
        actions={
          canEditCategories || canViewReport ? (
            <div className="flex flex-wrap items-center gap-3">
              {canViewReport ? (
                <Link
                  href="/reports/routing"
                  className="text-sm text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
                >
                  Routing report
                </Link>
              ) : null}
              {canEditCategories ? (
                <Link
                  href="/admin/categories"
                  className="text-sm text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
                >
                  Categories and route groups
                </Link>
              ) : null}
            </div>
          ) : null
        }
      />

      <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-(--color-text-secondary)">
        <span>Category classifier:</span>
        <Badge tone={classifier.mode === 'apply' ? 'success' : 'warning'}>
          {CLASSIFIER_LABELS[classifier.mode]}
        </Badge>
        {classifier.mode === 'apply' && !classifier.keyConfigured ? (
          <Badge tone="warning">No TypeSafe key</Badge>
        ) : null}
        <span>
          Routing window: {classifier.windowMinutes}{' '}
          {classifier.windowMinutes === 1 ? 'minute' : 'minutes'}
        </span>
        <InfoTip label="Routing window">
          How long a new ticket on a channel routing by category waits — unassigned, its
          out-of-hours reply held — for the classifier to file it. Copied onto each ticket when it
          arrives, so a change never moves a window already running.
        </InfoTip>
      </p>
      <ClassifierNotice classifier={classifier} routing={routing} />

      <div className="mb-4 flex flex-col gap-2">
        <h3 className="text-sm font-medium">Where each category goes</h3>
        <ul className="divide-y divide-(--color-border-subtle) rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) text-sm">
          {readiness.categories.length === 0 ? (
            <li className="px-4 py-3 text-(--color-text-secondary)">
              No active categories: nothing can route.
            </li>
          ) : null}
          {readiness.categories.map((category) => (
            <CategoryLine key={category.id} category={category} />
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Channels off their default group</h3>
        {routing.length === 0 ? (
          <p className="rounded-xl border border-dashed border-(--color-border-default) px-4 py-6 text-center text-xs text-(--color-text-secondary)">
            Every channel starts its tickets in its default group. Choose a category mode under
            Routing in a channel&rsquo;s editor to route one.
          </p>
        ) : (
          <ul className="divide-y divide-(--color-border-subtle) rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) text-sm">
            {routing.map((channel) => (
              <ChannelLine key={channel.id} channel={channel} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * What a row in the channel list says about its routing: nothing on its
 * default group, and otherwise its mode and whether a new ticket gets a hold,
 * a record or nothing — the panel below says why. A row that starts routing
 * with no classifier key is a warning, never a success: nothing files its
 * tickets but a person or a rule, so a held ticket waits out the window and a
 * shadow record reads "Window ran out", and the list is all an admin sees
 * without scrolling to the panel.
 */
export function RoutingBadge({ channel }: { channel: ChannelRouting | undefined }) {
  if (!channel || channel.column === 'default_group') return null;
  const { tone, suffix } = badgeLook(channel);
  return (
    <Badge tone={tone}>
      {ROUTING_MODE_LABELS[channel.column]}
      {suffix}
    </Badge>
  );
}

/** The badge's tone and what follows the mode, decided together so no state can get one and not the other. */
function badgeLook(channel: ChannelRouting): {
  tone: 'success' | 'info' | 'warning';
  suffix: string;
} {
  if (channel.noKey) return { tone: 'warning', suffix: ' — no classifier key' };
  if (channel.starts === 'live') return { tone: 'success', suffix: '' };
  if (channel.starts === 'shadow') return { tone: 'info', suffix: '' };
  return { tone: 'warning', suffix: ' — not routing' };
}

/**
 * The classifier's state, said once for every channel off its default group
 * rather than on each of them: it is the same fact for all, and repeated per
 * row it buried the warnings that are about one channel. Only where some row
 * would start routing in Apply — the idle notice — or does — the no-key one:
 * with every row locked, inactive, second of its type or owned, it would
 * describe routing that cannot happen. The words are `mode-copy.ts`'s, which
 * `/reports/routing` says too.
 */
function ClassifierNotice({
  classifier,
  routing,
}: {
  classifier: RoutingReadiness['classifier'];
  routing: ChannelRouting[];
}) {
  if (classifier.mode !== 'apply') {
    return routing.some((channel) => channel.routesInApply) ? (
      <Notice tone="warning" icon className="mb-4">
        {idleClassifierSentence(classifier.mode)}
      </Notice>
    ) : null;
  }
  return routing.some((channel) => channel.noKey) ? (
    <Notice tone="warning" icon className="mb-4">
      {noKeyRoutingSentence(classifier.windowMinutes)}
    </Notice>
  ) : null;
}

const CLASSIFIER_LABELS = { off: 'Off', shadow: 'Shadow', apply: 'Apply' } as const;

const GAP_BADGES: Record<GroupGap, string> = {
  manual: 'Nobody assigned automatically',
  unstaffed: 'No active members',
  nobody_accepting: 'Nobody accepting now',
  closed: 'Closed now',
};

function CategoryLine({ category }: { category: CategoryReadiness }) {
  const group = category.routeGroup;
  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{category.labelEn}</span>
        <span className="text-(--color-text-secondary)">→</span>
        {group ? (
          <span dir="auto">{group.name}</span>
        ) : (
          <span className="text-(--color-text-secondary)">
            No route group — its tickets stay in their channel&rsquo;s default group
          </span>
        )}
        {category.gaps.map((gap) => (
          <Badge key={gap} tone="warning">
            {GAP_BADGES[gap]}
          </Badge>
        ))}
      </div>
      {group ? <GroupLine group={group} /> : null}
    </li>
  );
}

/** A group's strategy, who is there, and its hours, in the words assignment would act on. */
function GroupLine({ group }: { group: GroupFacts }) {
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-(--color-text-secondary)">
      <span>{STRATEGY_LABELS[group.strategy]}</span>
      <span className="inline-flex items-center gap-1">
        {group.acceptingNow} of {group.members} {group.members === 1 ? 'member' : 'members'}{' '}
        accepting now
        <InfoTip label="Accepting now">
          Members signed in with the console open and their accepting switch on — the test
          assignment makes before it hands anybody a ticket. A ticket&rsquo;s skills or an
          agent&rsquo;s cap can still pass somebody over.
        </InfoTip>
      </span>
      <span>{hoursSentence(group)}</span>
    </p>
  );
}

function hoursSentence(group: GroupFacts): string {
  if (group.hours === 'none') return 'No business hours set anywhere: assigns at any hour';
  const whose = group.hours === 'own' ? 'its own hours' : 'the default hours';
  const now = group.openNow
    ? `Open now (${whose})`
    : group.opensAt
      ? `Closed now (${whose}), opens ${formatDateTime(group.opensAt)}`
      : `Closed now (${whose}), with no opening in the next two weeks`;
  return group.assignWithinHoursOnly || group.strategy === 'manual'
    ? now
    : `${now}; assigns at any hour`;
}

function ChannelLine({ channel }: { channel: ChannelRouting }) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <ChannelBadge channel={channel.type} />
        <span className="font-medium" dir="auto">
          {channel.name}
        </span>
        <RoutingBadge channel={channel} />
        <span className="ms-auto text-xs text-(--color-text-secondary)">
          {statusSentence(channel)}
        </span>
      </div>
      {channel.warnings.map((warning) => (
        <Notice key={warning.kind} tone={warning.kind === 'rules' ? 'info' : 'warning'} icon>
          <WarningText warning={warning} />
        </Notice>
      ))}
    </li>
  );
}

function statusSentence(channel: ChannelRouting): string {
  switch (channel.starts) {
    case 'live':
      return channel.noKey
        ? 'New tickets are held for the whole window, then stay in the default group, unless somebody decides first'
        : 'New tickets are held until routed';
    case 'shadow':
      return channel.noKey
        ? 'New tickets are recorded, not held, and read “Window ran out” unless somebody decides first'
        : 'New tickets are recorded, not held';
    case null:
      // Idle, not locked: the warnings under it are what Apply would meet,
      // kept on purpose, since this panel is read before routing is turned on.
      return channel.routesInApply
        ? 'Idle until the classifier is in Apply; below, what routing would meet then'
        : 'New tickets are neither held nor recorded';
  }
}

function WarningText({ warning }: { warning: ChannelWarning }) {
  switch (warning.kind) {
    case 'never_routes':
      return <>{`${ROUTING_LOCK_REASONS[warning.reason]} Its saved mode does nothing.`}</>;
    case 'inactive':
      return <>Inactive: nothing is filed under it, so its mode does nothing until it is on.</>;
    case 'not_filing_row':
      return (
        <>
          New tickets of this type are filed under &ldquo;
          <span dir="auto">{warning.filingRow}</span>
          &rdquo;, the oldest active row of it, so this row&rsquo;s mode does nothing.
        </>
      );
    case 'owned':
      return (
        <>
          Owned by <span dir="auto">{warning.owner}</span>: its tickets are theirs from the moment
          they arrive, so nothing is held or recorded. Hand the number back to the team to route it.
        </>
      );
    case 'route_gaps':
      return (
        <>
          {warning.categories.map((category, index) => (
            <span key={category.label} className="block">
              {index === 0 ? 'Routed tickets would wait unassigned: ' : ''}
              {category.label} goes to <span dir="auto">{category.group}</span>, which{' '}
              {gapsSentence(category.gaps)}.
            </span>
          ))}
        </>
      );
    case 'default_group':
      return warning.group ? (
        <>
          Tickets that stay put — no category settled, or one with no route group — wait in{' '}
          <span dir="auto">{warning.group.name}</span>, which {gapsSentence(warning.gaps)}.
        </>
      ) : (
        <>
          It has no default group: a ticket that settles no category, or one with no route group,
          lands in no group, and nobody is assigned it.
        </>
      );
    case 'rules':
      return (
        <>
          These rules decide a held ticket before the router does, and it then goes where the rule
          says rather than by its category:
          <ul className="mt-1 list-disc ps-4">
            {warning.rules.map((rule) => (
              <li key={rule.id}>
                <span dir="auto">{rule.name}</span> ({TRIGGER_LABELS[rule.trigger]}){' '}
                {actionSentence(rule)},{' '}
                {rule.everyTicket
                  ? 'on every ticket from this channel'
                  : 'on the tickets it matches'}
              </li>
            ))}
          </ul>
        </>
      );
  }
}

const TRIGGER_LABELS: Record<HoldEndingRule['trigger'], string> = {
  on_create: 'when a ticket is created',
  on_update: 'when a ticket is updated',
  time_based: 'on the sweep',
};

function actionSentence(rule: HoldEndingRule): string {
  switch (rule.action) {
    case 'assign_agent':
      return 'assigns it to a named agent';
    case 'assign_group':
      return rule.groupName ? `moves it to ${rule.groupName}` : 'takes it out of its group';
    case 'auto_assign':
      return `moves it to ${rule.groupName ?? 'another group'} and assigns it there`;
  }
}

const GAP_SENTENCES: Record<GroupGap, string> = {
  manual: 'assigns nobody automatically',
  unstaffed: 'has no active members',
  nobody_accepting: 'has nobody accepting tickets right now',
  closed: 'is outside the hours it assigns within',
};

function gapsSentence(gaps: GroupGap[]): string {
  return list(gaps.map((gap) => GAP_SENTENCES[gap]));
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
