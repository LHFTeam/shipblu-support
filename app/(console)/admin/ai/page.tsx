import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Card, PageHeader, type BadgeTone } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { requireAnyPermission } from '@/lib/auth/guard';
import { can, type Permission } from '@/lib/auth/permissions';
import type { SessionAgent } from '@/lib/auth/session';
import { loadSuggestionSettings } from '@/lib/canned-suggest/settings';
import type { CategoryAiMode } from '@/lib/category-ai/modes';
import { readCategoryAiSettings } from '@/lib/category-ai/settings';
import { jevStatus } from '@/lib/category-ai/status';
import { formatDateTime } from '@/lib/format';
import {
  priorityAiMinProbability,
  priorityAiMode,
  type PriorityAiMode,
} from '@/lib/priority-ai/settings';
import { runLabels, type RunLabelRow } from '@/lib/subcategorise-ai/report';
import { CONVERSATION_CHANNELS, hiddenChannels } from '@/lib/tickets/channel-policy';
import { typesafeConfigured, typesafeModel } from '@/lib/typesafe/client';

export const dynamic = 'force-dynamic';

/**
 * Every place TypeSafe's Jev model is asked a question, on one page: what each
 * answer may change, whether it is on here, where it is switched and where it
 * is graded.
 *
 * Read-only, and that is the design rather than a stage it has not reached.
 * Each switch stays beside what it changes — the category classifier's on
 * Categories, beside the categories it files under; the suggestion's on Canned
 * responses, beside the list it picks from; priority's in the environment,
 * where it has always been — because the question an admin brings to those
 * pages is answered by what is on them. A second copy of a switch here would
 * be two forms saving one row, and the stale one would win. So this page links,
 * and says which switches have no page at all.
 *
 * It admits anybody holding one of the two pages' keys or the subcategory
 * key, and asks `can()` again for each link, so it never offers a door the
 * page behind it refuses. The states are not secret — the category report
 * prints the classifier's to every agent who reads reports — but a shadow
 * run's figures are subcategory data, read only for the key that opens the
 * shadow page and through the same bot-channel gate.
 *
 * Every read is the one the switch's own page makes, so the two cannot
 * disagree: the classifier's row uncached, as `/admin/categories` reads it;
 * the suggestion's through the memo `/admin/canned` reads; priority's from
 * `process.env`, as the classifier itself reads it.
 */
export default async function AiFeaturesPage() {
  const agent = await requireAnyPermission([
    'admin.categories',
    'admin.fields',
    'admin.subcategories',
  ]);

  const keyConfigured = typesafeConfigured();
  const mayReadRuns = can(agent, 'admin.subcategories');

  // `hiddenChannels` is the shadow page's own gate: every run row joins a
  // ticket, so without it the latest run's count includes bot transcripts an
  // agent without `ticket.view.bot` is kept from everywhere else.
  const hidden = new Set<string>(hiddenChannels(agent));
  const visibleChannels = CONVERSATION_CHANNELS.filter((channel) => !hidden.has(channel));

  const [category, suggestions, runs] = await Promise.all([
    readCategoryAiSettings(),
    loadSuggestionSettings(),
    mayReadRuns ? runLabels(visibleChannels) : Promise.resolve(null),
  ]);

  const priorityMode = priorityAiMode();
  const priorityThreshold = priorityAiMinProbability();
  const categoryStatus = jevStatus(category.mode, keyConfigured, category.minProbability);
  const window = minutes(category.routingWindowMinutes);

  return (
    <>
      <PageHeader
        title="AI features"
        description="Every place this helpdesk asks TypeSafe’s Jev model a question: what each answer may change, whether it is on here, where it is switched and where it is graded. Each switch lives beside what it changes; this page only reports."
      />

      <Card className="mb-6 flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">TypeSafe API key</h2>
          {keyConfigured ? (
            <Badge tone="success">Set in this environment</Badge>
          ) : (
            <Badge tone="warning">Not set in this environment</Badge>
          )}
        </div>
        <p className="text-(--color-text-secondary)">
          Every feature below sends customer messages to TypeSafe, a third party, and only while
          this environment holds <code>TYPESAFE_API_KEY</code>.{' '}
          {keyConfigured
            ? 'The key switches nothing on by itself: the category classifier, the reply suggestions and the priority classifier each have a switch of their own, and the jobs run by hand — the subcategory model’s runs and the category classifier’s backfill — send only when somebody starts one.'
            : 'Without it nothing is sent, whatever any switch below says.'}
        </p>
        <p className="text-xs text-(--color-text-secondary)">
          Asks for model <code>{typesafeModel()}</code>. Every answer is recorded with the version
          that actually gave it.
        </p>
      </Card>

      <div className="flex flex-col gap-4">
        <Feature
          title="Category classifier"
          state={modeBadge(category.mode, keyConfigured, 'On — files tickets')}
          about={
            <>
              Reads a customer&rsquo;s message and chooses which team&rsquo;s work it is &mdash; one
              of the active categories, or none. It is asked about the first five messages a
              customer writes on a ticket nobody has answered yet, on every channel but the bot, and
              the first answer at or above the threshold that names a category settles the ticket.
            </>
          }
          status={
            <>
              Jev is <b>{categoryStatus.bold}</b>
              {categoryStatus.tail}
            </>
          }
          changed={changedLine(category.changedAt, category.changedBy)}
          tip={
            <>
              A category a person, a rule, a form&rsquo;s default or an agent opening the ticket
              chose is never touched, and one Jev chose is changed like any other. Its backfill,
              started by hand as <code>npm run job -- backfill_category_ai</code>, asks about older
              tickets under a label of its own whatever the mode says, and in its <code>apply</code>{' '}
              mode files open tickets from a recorded run&rsquo;s answers.
            </>
          }
          rows={[
            {
              term: 'May change',
              detail: (
                <>
                  In <b>apply</b>, a ticket&rsquo;s category. On a channel that routes by category
                  that is what sends a new ticket to a team, and the ticket waits up to {window} for
                  it before it is routed without one. In <b>shadow</b>, nothing.
                </>
              ),
            },
            {
              term: 'Sends',
              detail:
                'The customer’s message, up to three of their earlier messages on the ticket, its channel and whether it is a public comment, and every active category’s English label and description. Never an internal note, never the team’s replies.',
            },
            {
              term: 'Switched',
              detail: (
                <PageLink agent={agent} permission="admin.categories" href="/admin/categories">
                  Categories
                </PageLink>
              ),
            },
            {
              term: 'Graded',
              detail: (
                <PageLink agent={agent} permission="report.view" href="/reports/category-ai">
                  Category classifier report
                </PageLink>
              ),
            },
          ]}
        />

        <Feature
          title="Reply suggestions"
          state={suggestionBadge(suggestions.enabled, keyConfigured)}
          about={
            <>
              When an agent clicks into an empty reply box, Jev picks the one canned response that
              agent can see that fits the conversation best &mdash; or none &mdash; and it is shown
              as grey text in the box. It asks once per agent, per ticket, per newest message.
            </>
          }
          status={suggestionStatus(suggestions.enabled, keyConfigured)}
          changed={changedLine(suggestions.changedAt, suggestions.changedBy)}
          rows={[
            {
              term: 'May change',
              detail:
                'Nothing. Jev only chooses; the text is the stored response, and nothing reaches a customer until the agent puts it in and presses Send.',
            },
            {
              term: 'Sends',
              detail:
                'The ticket’s last ten messages, the customer’s and the team’s (never internal notes); the subject, on a ticket answered by email; and the title and text of every response that agent can see.',
            },
            {
              term: 'Switched',
              detail: (
                <PageLink agent={agent} permission="admin.fields" href="/admin/canned">
                  Canned responses
                </PageLink>
              ),
            },
            {
              term: 'Graded',
              detail: (
                <PageLink agent={agent} permission="report.view" href="/reports/canned-suggestions">
                  Reply suggestions report
                </PageLink>
              ),
            },
          ]}
        />

        <Feature
          title="Priority classifier"
          state={modeBadge(priorityMode, keyConfigured, 'On — sets priority')}
          about={
            <>
              Reads each message with words in it that a ticket&rsquo;s own customer writes, on
              every channel but the bot, and judges how urgently the team needs to act on it: low,
              medium, high or urgent.
            </>
          }
          status={priorityStatus(priorityMode, keyConfigured, priorityThreshold)}
          tip={
            <>
              A priority a person, a rule, a form&rsquo;s default or an agent opening the ticket
              chose is never touched. Only the answer to the customer&rsquo;s opening message may
              lower a ticket; every later message may raise it and never lower it.
            </>
          }
          rows={[
            {
              term: 'May change',
              detail: (
                <>
                  In <b>apply</b>, a ticket&rsquo;s priority, which moves its SLA deadlines. In{' '}
                  <b>shadow</b>, nothing.
                </>
              ),
            },
            {
              term: 'Sends',
              detail:
                'The customer’s message, up to three of their earlier messages on the ticket, and its channel.',
            },
            {
              term: 'Switched',
              detail: (
                <>
                  No switch in the console. It is the <code>PRIORITY_AI</code> environment variable
                  &mdash; <code>off</code>, <code>shadow</code> or <code>apply</code> &mdash; with{' '}
                  <code>PRIORITY_AI_MIN_PROBABILITY</code> as its threshold, set where the
                  servers&rsquo; environment is set.{' '}
                  <InfoTip label="the priority switch">
                    Both the web service and the worker read it; this page shows the web
                    service&rsquo;s value. A value that is not one of the three reads as off.
                  </InfoTip>
                </>
              ),
            },
            {
              term: 'Graded',
              detail: (
                <>
                  No screen yet. Every answer, applied or not, is recorded in{' '}
                  <code>ai_priority_runs</code>, and nothing in the console reads them. A priority
                  it sets shows on the ticket&rsquo;s timeline as <code>jev:priority</code>, with
                  how likely Jev thought it.
                </>
              ),
            },
          ]}
        />

        <Feature
          title="Subcategory model"
          state={
            keyConfigured
              ? { tone: 'info', label: 'Shadow only — run by hand' }
              : { tone: 'warning', label: 'No key — cannot run' }
          }
          about={
            <>
              Asked which subcategory a message belongs to, over the same list the rules answer
              over, so the two can be compared. A measurement: its answers are recorded beside what
              the rules said and are never applied.
            </>
          }
          status={runStatus(runs, keyConfigured, hidden.size > 0)}
          rows={[
            {
              term: 'May change',
              detail:
                'Nothing. Its answers go to a table of their own, which only the shadow runs page reads.',
            },
            {
              term: 'Sends',
              detail:
                'Each message in the run, up to three earlier customer messages on its ticket unless the run is started without context, its channel, and the subcategories it may answer with.',
            },
            {
              term: 'Switched',
              detail: (
                <>
                  No switch. A person starts a run by hand with{' '}
                  <code>npm run job -- backfill_subcategorise_ai runLabel=…</code>, which leaves out
                  the bot channel unless told otherwise.
                </>
              ),
            },
            {
              term: 'Graded',
              detail: (
                <PageLink
                  agent={agent}
                  permission="admin.subcategories"
                  href="/admin/subcategories/shadow"
                >
                  Shadow runs
                </PageLink>
              ),
            },
          ]}
        />
      </div>
    </>
  );
}

type State = { tone: BadgeTone; label: string };

type FeatureRow = { term: string; detail: ReactNode };

function Feature({
  title,
  state,
  about,
  status,
  changed,
  tip,
  rows,
}: {
  title: string;
  state: State;
  about: ReactNode;
  status: ReactNode;
  changed?: string;
  tip?: ReactNode;
  rows: FeatureRow[];
}) {
  return (
    <Card className="flex flex-col gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{title}</h2>
        <Badge tone={state.tone}>{state.label}</Badge>
        {tip ? <InfoTip label={`the ${title.toLowerCase()}`}>{tip}</InfoTip> : null}
      </div>
      <p className="text-(--color-text-secondary)">{about}</p>
      <p>{status}</p>
      {changed ? <p className="text-xs text-(--color-text-secondary)">{changed}</p> : null}
      {/* Term beside detail from `sm`, stacked below it: a fixed first column
          on a phone left the detail a column of single words. */}
      <dl className="mt-1 grid gap-x-4 gap-y-2 border-t border-(--color-border-subtle) pt-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
        {rows.map((row) => (
          <div key={row.term} className="contents">
            <dt className="text-xs font-medium text-(--color-text-secondary) sm:pt-0.5">
              {row.term}
            </dt>
            <dd className="min-w-0">{row.detail}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/**
 * A link to the page that owns a switch or a grade, or, for somebody that page
 * would refuse, its name and the reason there is no link: a link the page then
 * answers with "forbidden" is a dead end, and leaving the name out would hide
 * where the thing is from somebody who can ask the person who holds the key.
 */
function PageLink({
  agent,
  permission,
  href,
  children,
}: {
  agent: SessionAgent;
  permission: Permission;
  href: string;
  children: string;
}) {
  if (can(agent, permission)) {
    return (
      <Link href={href} className="font-medium text-(--color-text-link) underline">
        {children}
      </Link>
    );
  }
  return (
    <span>
      {children} <span className="text-(--color-text-secondary)">(your role does not open it)</span>
    </span>
  );
}

/**
 * One badge for the two three-state switches. The key is read into it because
 * "Shadow" over a classifier that is asked nothing is the badge saying the
 * false half — the reason `jevStatus` reads the key with the mode.
 */
function modeBadge(
  mode: CategoryAiMode | PriorityAiMode,
  keyConfigured: boolean,
  applyLabel: string,
): State {
  if (mode === 'off') return { tone: 'neutral', label: 'Off' };
  if (!keyConfigured) return { tone: 'warning', label: 'No key — asks nothing' };
  return mode === 'shadow'
    ? { tone: 'info', label: 'Shadow — records only' }
    : { tone: 'success', label: applyLabel };
}

function suggestionBadge(enabled: boolean, keyConfigured: boolean): State {
  if (!enabled) return { tone: 'neutral', label: 'Off' };
  if (!keyConfigured) return { tone: 'warning', label: 'No key — suggests nothing' };
  return { tone: 'success', label: 'On' };
}

function suggestionStatus(enabled: boolean, keyConfigured: boolean): ReactNode {
  if (!enabled) {
    return (
      <>
        Switched <b>off</b>: the reply box suggests nothing.
      </>
    );
  }
  if (!keyConfigured) {
    return (
      <>
        Switched <b>on</b>, but this environment has no <code>TYPESAFE_API_KEY</code>, so nothing is
        suggested.
      </>
    );
  }
  return (
    <>
      Switched <b>on</b> for every agent who can reply.
    </>
  );
}

/** `jevStatus`'s sentences, for a switch read from the environment rather than a row. */
function priorityStatus(
  mode: PriorityAiMode,
  keyConfigured: boolean,
  minProbability: number,
): ReactNode {
  if (mode === 'off') {
    return (
      <>
        <code>PRIORITY_AI</code> reads as <b>off</b> here, so Jev is asked nothing.
      </>
    );
  }
  const threshold = `, at a threshold of ${minProbability}`;
  if (!keyConfigured) {
    return (
      <>
        <code>PRIORITY_AI</code> is set to <b>{mode}</b>
        {threshold}, but this environment has no <code>TYPESAFE_API_KEY</code>, so Jev is asked
        nothing and {mode === 'shadow' ? 'records' : 'sets'} nothing.
      </>
    );
  }
  return mode === 'shadow' ? (
    <>
      Jev is <b>in shadow: asked, and its answers recorded, with no priority changed</b>
      {threshold}.
    </>
  ) : (
    <>
      Jev is <b>setting priorities</b>
      {threshold}.
    </>
  );
}

/**
 * When it runs, and the newest run for somebody who may read runs — and
 * nothing more: `runLabels` stops at fifty labels, so a count of runs would be
 * a floor that reads as a total.
 */
function runStatus(
  runs: RunLabelRow[] | null,
  keyConfigured: boolean,
  channelsHidden: boolean,
): ReactNode {
  const when = keyConfigured ? (
    <>
      Runs <b>only when somebody starts one</b>.
    </>
  ) : (
    <>
      This environment has no <code>TYPESAFE_API_KEY</code>, so a run started here{' '}
      <b>stops without asking anything</b>.
    </>
  );
  if (runs === null) return when;

  const latest = runs[0];
  return (
    <>
      {when}{' '}
      {latest ? (
        <>
          Latest run “{latest.runLabel}”: {latest.rows} message{latest.rows === 1 ? '' : 's'}
          {latest.failed > 0 ? `, ${latest.failed} failed` : ''}
          {latest.lastAt ? `, the last recorded ${formatDateTime(latest.lastAt)}` : ''}.
        </>
      ) : channelsHidden ? (
        'No runs recorded that you can see.'
      ) : (
        'No runs recorded yet.'
      )}
    </>
  );
}

function changedLine(changedAt: Date | null, changedBy: string | null): string {
  if (!changedAt) return 'Never switched on.';
  return `Last changed ${formatDateTime(changedAt)}${changedBy ? ` by ${changedBy}` : ''}.`;
}

function minutes(count: number): string {
  return `${count} ${count === 1 ? 'minute' : 'minutes'}`;
}
