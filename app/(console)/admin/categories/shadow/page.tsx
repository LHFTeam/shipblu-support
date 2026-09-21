import Link from 'next/link';
import { Badge, Cell, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { requirePermission } from '@/lib/auth/guard';
import { reportFor, runLabels } from '@/lib/categorise-ai/report';
import { CONVERSATION_CHANNELS, hiddenChannels } from '@/lib/tickets/channel-policy';

export const dynamic = 'force-dynamic';

/**
 * What the model said about the archive, beside what the rules said.
 *
 * Read-only, and that is the whole design rather than a stage it has not reached
 * yet. Nothing on this page writes, and nothing it reads is read by anything
 * else: `ai_category_runs` is a shadow table that no rollup, no review queue and
 * no primary ladder touches. A control here that promoted a prediction into
 * `conversation_categories` would be the change this experiment exists to
 * inform, made before the experiment had answered anything.
 *
 * It leads with what the run holds rather than with a result, for the reason
 * `/reports/categories` prints its own window (§6.54): a run over 640 messages
 * from one channel and a run over the whole archive render identically, and a
 * number is only interpretable next to what it was measured on.
 */
export default async function ShadowCategorisationPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  const agent = await requirePermission('admin.categories');

  /*
   * The same gate `/admin/categories/review` calls its most important line.
   *
   * Every query behind this page joins `conversations`, so without it the page
   * reports on bot transcripts to anybody holding `admin.categories` — including
   * the agents `ticket.view.bot` exists to keep out. Aggregates leak less than
   * that page's ticket list, which is a reason to apply the same rule rather
   * than to invent a softer one.
   */
  const hidden = new Set<string>(hiddenChannels(agent));
  const visibleChannels = CONVERSATION_CHANNELS.filter((channel) => !hidden.has(channel));

  const runs = await runLabels(visibleChannels);
  const { run: requested } = await searchParams;

  // A label from the query string is matched against the list rather than passed
  // through: the value reaches a SQL parameter either way, but an unmatched one
  // would render an empty report that reads exactly like a run that found
  // nothing.
  const selected = runs.find((run) => run.runLabel === requested) ?? runs[0];

  if (!selected) {
    return (
      <>
        <PageHeader
          title="Shadow categorisation"
          description="What TypeSafe's model says about inbound messages, recorded beside what the rules say. A measurement only — nothing here is applied to a ticket."
        />
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
          <p className="font-medium">No runs recorded yet.</p>
          <p className="mt-2 opacity-70">
            A run is started by hand and writes one row per message. It needs{' '}
            <code className="rounded bg-[var(--muted)] px-1">TYPESAFE_API_KEY</code> set on the
            production environment group; without it the job reports the key is missing and does
            nothing.
          </p>
          <p className="mt-2 opacity-70">
            Start the smallest useful one with{' '}
            <code className="rounded bg-[var(--muted)] px-1">
              npm run job -- backfill_categorise_ai runLabel=smoke limit=5
            </code>
            , read the five rows, then widen.
          </p>
        </div>
      </>
    );
  }

  const report = await reportFor(selected.runLabel, visibleChannels);
  const { totals } = report;

  return (
    <>
      <PageHeader
        title="Shadow categorisation"
        description="What TypeSafe's model says about inbound messages, recorded beside what the rules say. A measurement only — nothing here is applied to a ticket, and no report reads it."
      />

      {runs.length > 1 ? (
        <nav className="mb-4 flex flex-wrap gap-2">
          {runs.map((run) => (
            <Link
              key={run.runLabel}
              href={`/admin/categories/shadow?run=${encodeURIComponent(run.runLabel)}`}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                run.runLabel === selected.runLabel
                  ? 'border-[var(--brand)] bg-[var(--muted)] font-medium'
                  : 'border-[var(--border)] hover:bg-[var(--muted)]'
              }`}
            >
              {run.runLabel}{' '}
              <span className="opacity-60">
                {run.rows}
                {run.failed > 0 ? ` · ${run.failed} failed` : ''}
              </span>
            </Link>
          ))}
        </nav>
      ) : null}

      {/* What the window holds, before any figure drawn from it. */}
      <section className="mb-5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
        <h2 className="font-medium">
          Run “{report.runLabel}” — {totals.rows} message{totals.rows === 1 ? '' : 's'}
        </h2>
        <p className="mt-2 opacity-70">
          {totals.rows === 0
            ? 'Nothing recorded under this label that you can see.'
            : `Measured ${dateRange(totals.firstAt, totals.lastAt)} by ${
                report.models.length > 0 ? report.models.join(', ') : 'an unrecorded model'
              }. ${totals.predicted} answered, ${totals.failed} failed, ${
                totals.withContext
              } sent with earlier messages as context. ${totals.inputTokens.toLocaleString()} input tokens${
                totals.avgLatencyMs === null
                  ? ''
                  : `, ${Math.round(totals.avgLatencyMs)}ms average round trip`
              }.`}
        </p>
        <p className="mt-2 opacity-70">
          Read every figure below next to the channel split — this archive is overwhelmingly one
          channel, so a single number over it describes that channel rather than the product.
        </p>
      </section>

      {totals.rows === 0 ? null : (
        <>
          <h2 className="mt-6 mb-2 flex items-center gap-1.5 text-sm font-medium">
            Per channel and script
            <InfoTip label="the channel and script split">
              Split by script because the rules are weakest on short Arabic — <code>\b</code> does
              not exist for Arabic, so the patterns lean on an explicit boundary helper — and a
              total would hide whichever half is carrying the result.
            </InfoTip>
          </h2>
          <Table
            head={[
              'Channel',
              'Script',
              'Messages',
              <span key="gaveup" className="inline-flex items-center gap-1">
                Rules gave up
                <InfoTip label="rules gave up">
                  Messages the rules filed as <code>meta.unclassified</code> — no pattern matched at
                  all. This is the pile the experiment exists to attack.
                </InfoTip>
              </span>,
              <span key="named" className="inline-flex items-center gap-1">
                Model named one
                <InfoTip label="model named one">
                  Of those, how many the model put an actual category on instead of also answering{' '}
                  <code>meta.unclassified</code>. Naming one is not the same as being right — check
                  the confidence band and read a sample.
                </InfoTip>
              </span>,
              <span key="agreed" className="inline-flex items-center gap-1">
                Agreed
                <InfoTip label="agreement">
                  The model&rsquo;s choice was among the categories the rules named for the same
                  message. Agreement is evidence the two read the message the same way, not evidence
                  either is correct.
                </InfoTip>
              </span>,
            ]}
          >
            {report.slices.map((slice) => (
              <Row key={`${slice.channel}-${slice.script}`}>
                <Cell>{slice.channel}</Cell>
                <Cell>
                  <Badge tone={slice.script === 'arabic' ? 'brand' : 'neutral'}>
                    {slice.script}
                  </Badge>
                </Cell>
                <Cell>
                  {slice.rows}
                  {slice.failed > 0 ? (
                    <span className="ms-2 opacity-60">{slice.failed} failed</span>
                  ) : null}
                </Cell>
                <Cell>{slice.rulesUnclassified}</Cell>
                <Cell>{slice.namedWhereRulesGaveUp}</Cell>
                <Cell>{slice.agreed}</Cell>
              </Row>
            ))}
          </Table>

          <h2 className="mt-6 mb-2 flex items-center gap-1.5 text-sm font-medium">
            By confidence band
            <InfoTip label="confidence here">
              <strong>
                Not the same quantity as the confidence on a ticket&rsquo;s categories.
              </strong>{' '}
              That one is an evidence grade — a hand-assigned weight per rule, combined so a pile of
              weak keywords cannot reach the auto band. This one is a statistic over the
              model&rsquo;s own probability distribution: all of it on one option is 1.0, and the
              more evenly it spreads the lower it goes. TypeSafe&rsquo;s published benchmark puts
              accuracy far higher above 0.9 than below it, which is why this table exists at all.
            </InfoTip>
          </h2>
          <Table
            head={[
              'Band',
              'Messages',
              'Said unclassified',
              <span key="agreed" className="inline-flex items-center gap-1">
                Agreed with rules
                <InfoTip label="agreement by band">
                  If agreement holds up in the high band and collapses in the low one, the
                  distribution is carrying real information and a threshold is worth choosing. If it
                  is flat, it is not.
                </InfoTip>
              </span>,
            ]}
          >
            {report.bands.map((band) => (
              <Row key={band.band}>
                <Cell>{band.band}</Cell>
                <Cell>{band.rows}</Cell>
                <Cell>{band.saidUnclassified}</Cell>
                <Cell>{band.agreedWithRules}</Cell>
              </Row>
            ))}
          </Table>

          {report.disagreements.length > 0 ? (
            <>
              <h2 className="mt-6 mb-2 flex items-center gap-1.5 text-sm font-medium">
                Where they differ
                <InfoTip label="disagreements">
                  The model&rsquo;s choice against the rules&rsquo; strongest one, most common
                  first. A pair that recurs is either a rule worth narrowing or a category the model
                  is reaching for too readily — reading a handful of the messages behind it is the
                  only way to tell which.
                </InfoTip>
              </h2>
              <Table head={['Model said', 'Rules said', 'Messages']}>
                {report.disagreements.map((row) => (
                  <Row key={`${row.aiKey}-${row.rulesKey}`}>
                    <Cell>{row.aiKey}</Cell>
                    <Cell>{row.rulesKey}</Cell>
                    <Cell>{row.rows}</Cell>
                  </Row>
                ))}
              </Table>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

/** Both instants, or the one there is. Cairo is the reporting zone everywhere else. */
function dateRange(firstAt: Date | null, lastAt: Date | null): string {
  const format = (at: Date) =>
    at.toLocaleString('en-GB', {
      timeZone: 'Africa/Cairo',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

  if (!firstAt || !lastAt) return 'at an unrecorded time';
  if (firstAt.getTime() === lastAt.getTime()) return `at ${format(firstAt)}`;
  return `between ${format(firstAt)} and ${format(lastAt)}`;
}
