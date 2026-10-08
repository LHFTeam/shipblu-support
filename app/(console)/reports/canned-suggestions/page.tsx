import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Stat } from '@/components/charts';
import { Badge, Cell, EmptyState, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import {
  byChannelAndLanguage,
  byProbability,
  byResponse,
  confusions,
  coverage,
  headline,
} from '@/lib/canned-suggest/report';
import { NONE_KEY } from '@/lib/canned-suggest/request';
import { loadSuggestionSettings } from '@/lib/canned-suggest/settings';
import { channelLabel, formatDateTime } from '@/lib/format';
import { rangeIn, reportingContext } from '@/lib/reports/rollup';
import { typesafeConfigured } from '@/lib/typesafe/client';

export const dynamic = 'force-dynamic';

const RANGES = [7, 30, 90] as const;

/**
 * How Jev's canned-response suggestions in the reply box are doing: how often
 * one is taken, and which ones are right.
 *
 * Behind `report.view` like the other team reports. Not broken down by agent —
 * how each person treats the suggestions is a question about people, which is
 * `report.agents`, and it is not one this page set out to answer.
 *
 * Live rather than rolled up: `canned_suggestions` is one row per question asked,
 * a few hundred a day at the most, and these are counts over an indexed window.
 *
 * Every rate prints its numerator and denominator, and below ten it prints only
 * those — "3 of 4" says what "75%" hides, which is that it is four suggestions.
 */
export default async function CannedSuggestionsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const agent = await requireAgent();
  if (!can(agent, 'report.view')) notFound();

  const { days: requested } = await searchParams;
  const days = RANGES.includes(Number(requested) as (typeof RANGES)[number])
    ? Number(requested)
    : 30;

  const { zone } = await reportingContext();
  const range = rangeIn(zone, days);
  const window = { ...range, zone };

  const [head, responses, pairs, bands, slices, seen, settings] = await Promise.all([
    headline(window),
    byResponse(window),
    confusions(window),
    byProbability(window),
    byChannelAndLanguage(window),
    coverage(window),
    loadSuggestionSettings(),
  ]);
  const keyConfigured = typesafeConfigured();

  // Where the figures start, when that is inside the window — the §6.54 rule:
  // otherwise the three range buttons answer the same and read as broken.
  const firstDay = seen.firstSuggestionAt
    ? new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(seen.firstSuggestionAt)
    : null;
  const startsLate = firstDay !== null && firstDay > range.from;

  return (
    <div className="app-scroll h-full overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="Suggested responses"
        description={`${range.from} to ${range.to}, in ${zone}. How often agents take the canned response Jev suggests in the reply box, and which suggestions turn out to be right.`}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <nav className="flex gap-1 text-sm">
              {RANGES.map((each) => (
                <Link
                  key={each}
                  href={`/reports/canned-suggestions?days=${each}`}
                  aria-current={each === days ? 'page' : undefined}
                  className={`rounded-md px-2.5 py-1 ${
                    each === days ? 'bg-[var(--muted)] font-medium' : 'opacity-60 hover:opacity-100'
                  }`}
                >
                  {each} days
                </Link>
              ))}
            </nav>
            <Link
              href={`/reports?days=${days}`}
              className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm hover:bg-[var(--muted)]"
            >
              All reports
            </Link>
          </div>
        }
      />

      <div className="mb-6 max-w-2xl space-y-2">
        <p className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm text-[var(--muted-foreground)]">
          A suggestion counts as <b className="text-[var(--foreground)]">right</b> when the reply
          that followed carried that canned response &mdash; taken with Tab or picked from the list,
          edited or not &mdash; and when Jev said no response fits and the agent wrote their own.{' '}
          {settings.enabled && keyConfigured
            ? 'Suggestions are on.'
            : !settings.enabled
              ? 'Suggestions are switched off.'
              : 'Suggestions are switched on, but this environment has no TYPESAFE_API_KEY, so none are made.'}{' '}
          {can(agent, 'admin.fields') ? (
            <Link href="/admin/canned" className="underline">
              Change it on Canned responses
            </Link>
          ) : null}
        </p>

        {startsLate ? (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            This window opens on {range.from}, but the first suggestion was made on{' '}
            <b>{firstDay}</b>. A wider range cannot reach further back than that.
          </p>
        ) : null}
      </div>

      {head.requests === 0 ? (
        <EmptyState
          title="No suggestions in this window"
          hint={
            !settings.enabled
              ? 'Suggestions are switched off. An admin turns them on under Admin › Canned responses.'
              : `A suggestion is asked for when an agent clicks into an empty reply box on a ticket the customer has written on. ${
                  seen.lastAgentReplyAt
                    ? `An agent last sent a reply on ${formatDateTime(seen.lastAgentReplyAt)}.`
                    : 'No agent has sent a reply yet.'
                }`
          }
        />
      ) : (
        <>
          <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Taken"
              value={rate(head.accepted, head.shown)}
              hint={`${head.accepted} of ${head.shown} suggestions shown`}
              explain={
                <>
                  Suggestions an agent put in the box with Tab or Use, out of those that appeared in
                  an empty box. A suggestion that came back after the agent had started typing was
                  never seen and is not counted either way.
                </>
              }
            />
            <Stat
              label="Right"
              value={rate(head.shownRight, head.shownReplied)}
              hint={`${head.shownRight} of ${head.shownReplied} shown and then replied to`}
              explain={
                <>
                  Of the suggestions shown and followed by a reply, how many replies carried the
                  suggested response &mdash; however it got there. {head.rightViaTab} came in with
                  Tab, {head.rightViaPicker} were picked from the list instead.
                </>
              }
            />
            <Stat
              label="Said none fits"
              value={rate(head.none, head.answered)}
              hint={`${head.none} of ${head.answered} answers · ${head.noneMissed} of ${head.noneReplied} then sent a response anyway`}
              explain={
                <>
                  How often Jev answered that no canned response fits. The second figure is the
                  misses: tickets where it said none and the agent used one after all.
                </>
              }
            />
            <Stat
              label="Seen by suggestions"
              value={rate(seen.linked, seen.agentReplies)}
              hint={`${seen.linked} of ${seen.agentReplies} agent replies`}
              explain={
                <>
                  Agent replies in this window that had a suggestion behind them, shown or not. Low
                  is not Jev&rsquo;s fault: it is the switch being off, agents typing before
                  clicking into the box, or replies sent before this existed.
                </>
              }
            />
          </section>

          <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Right when never shown"
              value={rate(head.blindRight, head.blindReplied)}
              hint={`${head.blindRight} of ${head.blindReplied}`}
              explain={
                <>
                  Suggestions that arrived after the agent had started typing, so nobody saw them,
                  graded the same way. If this is much lower than <b>Right</b>, agents are taking
                  what they are shown rather than what fits.
                </>
              }
            />
            <Stat
              label="Sent as it stood"
              value={rate(head.unchanged, head.unchanged + head.extended + head.reworded)}
              hint={`${head.unchanged} unchanged · ${head.extended} added to · ${head.reworded} reworded`}
              explain={
                <>
                  Of the replies that carried the suggested response: sent exactly as stored, sent
                  whole with something added (a greeting, a tracking number), or reworded.
                </>
              }
            />
            <Stat
              label="Failed"
              value={rate(head.errored, head.requests)}
              hint={`${head.errored} of ${head.requests} asked · ${head.unanswered} never answered`}
              tone={head.errored > 0 && head.errored * 10 >= head.requests ? 'caution' : undefined}
            />
            <Stat
              label="Answer time"
              value={head.latencyP50 === null ? '—' : `${Math.round(head.latencyP50)} ms`}
              hint={`p90 ${head.latencyP90 === null ? '—' : `${Math.round(head.latencyP90)} ms`} · ${
                head.tokensAvg === null ? '—' : Math.round(head.tokensAvg).toLocaleString()
              } tokens a question, ${head.tokensTotal.toLocaleString()} in all`}
            />
          </section>

          <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold">
            By response
            <InfoTip label="By response">
              <b>Right</b> is the reply carrying the suggested response, out of the suggestions
              shown and replied to. <b>Missed</b> counts replies that carried this response when Jev
              had suggested something else or none &mdash; the column that shows a response Jev
              never picks. A response deleted since keeps the title it had.
            </InfoTip>
          </h2>
          <div className="mb-8">
            <Table
              head={[
                'Response',
                'Suggested',
                'Shown',
                'Taken',
                'Right',
                'Tab / list',
                'Unchanged / edited',
                'Other response',
                'Own words',
                'Missed',
              ]}
            >
              {responses.map((response) => (
                <Row key={response.id}>
                  <Cell>
                    {response.title}
                    {response.gone ? (
                      <span className="ms-2">
                        <Badge>deleted</Badge>
                      </span>
                    ) : null}
                  </Cell>
                  <Cell>{response.suggested}</Cell>
                  <Cell>{response.shown}</Cell>
                  <Cell>{rate(response.accepted, response.shown)}</Cell>
                  <Cell>{rate(response.shownRight, response.shownReplied)}</Cell>
                  <Cell>
                    {response.viaTab} / {response.viaPicker}
                  </Cell>
                  <Cell>
                    {response.unchanged} / {response.edited}
                  </Cell>
                  <Cell>{response.replaced}</Cell>
                  <Cell>{response.ownWords}</Cell>
                  <Cell>{response.missed}</Cell>
                </Row>
              ))}
            </Table>
          </div>

          {pairs.length > 0 ? (
            <>
              <h2 className="mb-2 text-sm font-semibold">Where Jev and the agent disagreed</h2>
              <div className="mb-8">
                <Table head={['Jev suggested', 'The reply carried', 'Times']}>
                  {pairs.map((pair) => (
                    <Row key={`${pair.suggested}→${pair.sent}`}>
                      <Cell>{pair.suggested === NONE_KEY ? 'None fits' : pair.suggested}</Cell>
                      <Cell>{pair.sent}</Cell>
                      <Cell>{pair.count}</Cell>
                    </Row>
                  ))}
                </Table>
              </div>
            </>
          ) : null}

          <h2 className="mb-2 flex items-center gap-1 text-sm font-semibold">
            By how sure Jev was
            <InfoTip label="By how sure Jev was">
              The share of Jev&rsquo;s probability it gave the response it suggested. A probability
              from the model, not the evidence grade a ticket&rsquo;s categories carry &mdash; the
              two are different quantities. Every suggestion is shown whatever its probability; this
              table is the evidence for hiding the unsure ones, if that is ever wanted.
            </InfoTip>
          </h2>
          <div className="mb-8">
            <Table head={['Probability', 'Suggested', 'Shown', 'Taken', 'Right']}>
              {bands.map((band) => (
                <Row key={band.band}>
                  <Cell>{band.band}</Cell>
                  <Cell>{band.suggested}</Cell>
                  <Cell>{band.shown}</Cell>
                  <Cell>{rate(band.accepted, band.shown)}</Cell>
                  <Cell>{rate(band.shownRight, band.shownReplied)}</Cell>
                </Row>
              ))}
            </Table>
          </div>

          <h2 className="mb-2 text-sm font-semibold">
            By channel and the customer&rsquo;s language
          </h2>
          <Table head={['Channel', 'Language', 'Asked', 'Suggested', 'Shown', 'Taken', 'Right']}>
            {slices.map((slice) => (
              <Row key={`${slice.channel}:${slice.locale}`}>
                <Cell>{channelLabel(slice.channel)}</Cell>
                <Cell>{{ ar: 'Arabic', en: 'English' }[slice.locale] ?? slice.locale}</Cell>
                <Cell>{slice.requests}</Cell>
                <Cell>{slice.suggested}</Cell>
                <Cell>{slice.shown}</Cell>
                <Cell>{rate(slice.accepted, slice.shown)}</Cell>
                <Cell>{rate(slice.shownRight, slice.shownReplied)}</Cell>
              </Row>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}

/**
 * A rate, or the two counts it is made of when there are too few for a
 * percentage to mean anything. Nothing at all is a dash, not "0%".
 */
function rate(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  if (denominator < 10) return `${numerator} of ${denominator}`;
  return `${Math.round((100 * numerator) / denominator)}%`;
}
