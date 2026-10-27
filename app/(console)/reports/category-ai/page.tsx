import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChannelBadge } from '@/components/channel';
import { Stat } from '@/components/charts';
import { InfoTip } from '@/components/tooltip';
import {
  Badge,
  buttonClass,
  Cell,
  EmptyState,
  Notice,
  PageHeader,
  Row,
  Table,
} from '@/components/ui';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { CATEGORY_AI_LIVE_LABEL } from '@/db/schema';
import { categoryLabel } from '@/lib/categories/choices';
import { listCategories } from '@/lib/categories/queries';
import { LABELS_WANTED, type Estimate, type Slice } from '@/lib/category-ai/grade';
import {
  categoryAiReport,
  deadClassifyJobs,
  runQuestion,
  runQuestions,
  type RunQuestion,
} from '@/lib/category-ai/report';
import { readCategoryAiSettings } from '@/lib/category-ai/settings';
import { allLimited } from '@/lib/concurrency';
import { channelLabel, formatDateTime } from '@/lib/format';
import { typesafeConfigured } from '@/lib/typesafe/client';
import { Quiet, rate, Section } from '../report-parts';

export const dynamic = 'force-dynamic';

/**
 * How Jev's choice of team for a ticket grades against what people chose
 * (`plans/ticket-category-routing.md`, 4.2) — the evidence for moving the
 * classifier from `shadow` to `apply`, and for the threshold it applies at.
 *
 * Behind `report.view`, like the suggested-responses report: it is about the
 * team's tickets, read by the people who label them. One run label, question
 * and mode at a time, chosen at the top; what counts as right and why is in
 * `lib/category-ai/grade.ts`. Every rate read off labelled tickets prints the
 * sample it was read on beside it, because the criterion for routing is a
 * precision on a stated number of labelled tickets; the rest print theirs
 * below ten, as the other reports do.
 */
export default async function CategoryAiReportPage({
  searchParams,
}: {
  searchParams: Promise<{ label?: string; q?: string; mode?: string }>;
}) {
  const agent = await requireAgent();
  if (!can(agent, 'report.view')) notFound();
  const { label, q, mode } = await searchParams;

  const [questions, settings, dead, categories] = await allLimited(2, [
    () => runQuestions(),
    () => readCategoryAiSettings(),
    () => deadClassifyJobs(),
    () => listCategories(),
  ]);
  const keyConfigured = typesafeConfigured();

  const asked = label !== undefined || q !== undefined || mode !== undefined;
  // A link names a run the list may have dropped past its limit: looked up
  // on its own, it still opens.
  const chosen = asked
    ? (questions.find(
        (each) => each.runLabel === label && each.fingerprint === q && each.mode === mode,
      ) ??
      (label !== undefined && q !== undefined && mode !== undefined
        ? await runQuestion(label, q, mode)
        : null))
    : (questions[0] ?? null);
  const report = chosen
    ? await categoryAiReport(chosen.runLabel, chosen.fingerprint, chosen.mode)
    : null;

  const labels = new Map(
    categories.map((category) => [
      category.key,
      categoryLabel(category.labelEn, category.isActive),
    ]),
  );
  const name = (key: string | null, none: string) =>
    key === null ? none : (labels.get(key) ?? key);

  return (
    <div className="app-scroll relative h-full overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="Category classifier"
        description="How Jev's choice of team for each ticket compares with the category a person chose, one run of answers at a time."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {can(agent, 'admin.categories') ? (
              <Link
                href="/admin/categories"
                className={buttonClass({ variant: 'secondary', size: 'sm' })}
              >
                Categories
              </Link>
            ) : null}
            <Link href="/reports" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              All reports
            </Link>
          </div>
        }
      />

      <div className="mb-6 max-w-3xl space-y-2">
        <Notice tone="neutral">
          Jev is{' '}
          <b className="text-(--color-text-primary)">
            {settings.mode === 'off'
              ? 'switched off'
              : settings.mode === 'shadow'
                ? 'in shadow: asked, and its answers recorded, with no ticket changed'
                : 'filing tickets'}
          </b>
          {settings.mode === 'off' ? '' : `, at a threshold of ${settings.minProbability}`}.
          {keyConfigured
            ? ''
            : ' This environment has no TYPESAFE_API_KEY, so it is asked nothing.'}{' '}
          A ticket counts as labelled when a person chose its category in the ticket&rsquo;s
          Category select before anything else wrote it &mdash; Jev, a rule or a form.
        </Notice>
        {dead.count > 0 && (chosen === null || chosen.runLabel === CATEGORY_AI_LIVE_LABEL) ? (
          <Notice tone="warning" icon>
            {dead.count === 1
              ? `One message has no live answer, in any mode or version of the question, because the job asking Jev about it failed for good, on ${formatDateTime(dead.first!)}.`
              : `${dead.count} messages have no live answer, in any mode or version of the question, because the jobs asking Jev about them failed for good, the first on ${formatDateTime(dead.first!)} and the last on ${formatDateTime(dead.last!)}.`}{' '}
            No figure below counts them.
          </Notice>
        ) : null}
      </div>

      <Section
        title="Runs"
        hint="Each row is one run label, one version of the question and one mode. Editing a category's label or description on the Categories page asks a new question, and switching from shadow to apply starts a new mode, so their answers start a row of their own and are never averaged with the old ones."
      >
        {questions.length === 0 ? (
          <Quiet>
            Jev has not answered anything yet. Answers appear here once the classifier is in shadow
            or apply, or once <code>backfill_category_ai mode=record</code> has run.
          </Quiet>
        ) : (
          <Table
            head={[
              'Run',
              'Question',
              'Mode',
              'Tickets',
              'Rows',
              'Messages from – to',
              'Last written',
            ]}
          >
            {questions.map((question) => (
              <QuestionRow
                key={`${question.runLabel}:${question.fingerprint}:${question.mode}`}
                question={question}
                current={question === chosen}
              />
            ))}
          </Table>
        )}
      </Section>

      {asked && !chosen ? (
        <Quiet>That run is not in the list above. Choose one of the runs there.</Quiet>
      ) : null}

      {report && chosen ? (
        report.total.judged === 0 ? (
          <EmptyState
            title="Nothing in this run was judged"
            hint="Every ticket in it was owned by a person, a rule or a form before Jev was asked, settled outside this run — under another version of the question, in the other mode or by a backfill's filing — past the cap, or every call failed."
          />
        ) : (
          <>
            <div className="mb-6 max-w-3xl space-y-2">
              {report.thresholdsInForce.length > 1 ? (
                <Notice tone="warning" icon>
                  The threshold changed during this run: its answers were decided against{' '}
                  {report.thresholdsInForce.map((value) => value.toFixed(2)).join(', ')}. The sweep
                  below is exact only at or below the lowest of them.
                </Notice>
              ) : null}
              {report.settlesUnlabellable ? (
                <Notice tone="info" icon>
                  Every ticket Jev settled in this run was written to before anybody could label it
                  {chosen.mode === 'apply' ? <> &mdash; by Jev, filing it</> : null}, and agreeing
                  with a filing leaves no label. So no rate here grades what Jev settled: Right and
                  precision are empty and recall is not measurable. Filed by Jev is the grade, by
                  how often a person moved a filing; the labels here are of tickets Jev never
                  settled, which is what it missed.
                </Notice>
              ) : report.writtenFirst > 0 ? (
                <Notice tone="info" icon>
                  {report.writtenFirst === 1
                    ? 'One judged ticket was'
                    : `${report.writtenFirst} judged tickets were`}{' '}
                  written to by Jev, a rule or a form before anybody labelled{' '}
                  {report.writtenFirst === 1 ? 'it' : 'them'}, and agreeing with what was written
                  leaves no label. Every rate here describes the other{' '}
                  {report.total.judged - report.writtenFirst}.
                </Notice>
              ) : null}
            </div>

            <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Right"
                value={percent(report.total.jev)}
                hint={`${report.total.jev.right} of ${report.total.jev.of} labelled · the rules ${report.total.rules.right} of ${report.total.rules.of}`}
                explain={
                  <>
                    Of the labelled tickets Jev settled, how many it settled on the category the
                    person chose, weighted to every ticket a label could reach (By category says
                    how). The rules&rsquo; figure is over the labelled tickets the subcategory rules
                    mapped to a category, on the first such message in Jev&rsquo;s window.
                  </>
                }
              />
              <Stat
                label="Settled"
                value={rate(report.total.settled, report.total.judged)}
                hint={`${report.total.settled} of ${report.total.judged} tickets judged`}
                explain={
                  <>
                    Tickets where some answer of Jev&rsquo;s was a category at or above the
                    threshold, out of those where it was asked. The rest stayed uncategorised: every
                    answer was unknown or below the threshold.
                  </>
                }
              />
              <Stat
                label="On the first message"
                value={rate(report.total.settledOnFirst, report.total.settled)}
                hint={`${report.total.settledOnFirst} of ${report.total.settled} settled tickets`}
                explain={
                  <>
                    Settled on the first message of the ticket this run judged &mdash; for the live
                    run, the first after the classifier was switched on. High is fine when first
                    messages say what they want; read it beside <b>Right</b>, since a greeting
                    settling a category shows here first.
                  </>
                }
              />
              <Stat
                label="Unknown"
                value={rate(report.total.unknowns, report.total.answers)}
                hint={`${report.total.unknowns} of ${report.total.answers} answers`}
                explain={
                  <>
                    Answers where Jev said the message is none of the categories &mdash; a greeting,
                    a thank-you, a lone photo. Unknown never settles a ticket.
                  </>
                }
              />
            </section>

            <Section
              title="By channel"
              hint="Every figure for the run, per channel the ticket came in on. Labelled counts tickets a person chose a category on before anything else wrote; Agrees counts settled tickets where the rules found the same category."
            >
              <Table
                head={[
                  'Channel',
                  'Tickets',
                  'Judged',
                  'Settled',
                  'First message',
                  'Unknown',
                  'Labelled',
                  'Jev right',
                  'Rules right',
                  'Agrees with rules',
                ]}
              >
                {[...report.slices, report.total].map((slice) => (
                  <SliceRow key={slice.channel ?? 'all'} slice={slice} />
                ))}
              </Table>
            </Section>

            <Section
              title="By category"
              hint={`Precision is right out of the labelled tickets Jev settled as the category; recall is right out of the tickets people labelled it, settled or not. The criterion for routing is a precision read on at least ${LABELS_WANTED} labelled tickets.`}
            >
              <Table
                head={[
                  'Category',
                  'Settled',
                  'Precision',
                  <span key="recall" className="flex items-center gap-1">
                    Recall
                    <InfoTip label="Recall">
                      The tickets to label are drawn evenly from each of Jev&rsquo;s answers, so a
                      rare answer&rsquo;s tickets are labelled far more often than a common
                      one&rsquo;s. Every rate here but Jev&rsquo;s precision mixes those answers, so
                      each labelled ticket counts for as many tickets of its answer as it stands
                      for: the percentage estimates every ticket in the run a label could reach, and
                      the counts beside it are the labelled tickets it was read on. Not measurable
                      is a category every ticket Jev settled as which was written to first: its hits
                      are the tickets nobody can label.
                    </InfoTip>
                  </span>,
                  'Rules precision',
                  'Rules recall',
                ]}
              >
                {report.categories.map((category) => (
                  <Row key={category.key}>
                    <Cell>{name(category.key, '')}</Cell>
                    <Cell>{category.settled}</Cell>
                    <Cell>
                      <Sampled estimate={category.precision} />
                    </Cell>
                    <Cell>
                      {category.recall === null ? (
                        <span className="text-(--color-text-tertiary)">Not measurable</span>
                      ) : (
                        <Sampled estimate={category.recall} />
                      )}
                    </Cell>
                    <Cell>
                      <Sampled estimate={category.rulesPrecision} />
                    </Cell>
                    <Cell>
                      <Sampled estimate={category.rulesRecall} />
                    </Cell>
                  </Row>
                ))}
              </Table>
            </Section>

            <Section
              title="What people chose, against what Jev settled on"
              hint="One row per category a person chose, one column per category Jev settled on: the labelled tickets as drawn, unweighted. The diagonal is right; Not settled is the tickets Jev never settled."
            >
              {report.confusion.length === 0 ? (
                <Quiet>
                  No ticket in this run is labelled yet. Label some from the list at the foot of
                  this page.
                </Quiet>
              ) : (
                <Confusion
                  cells={report.confusion}
                  keys={report.categories.map((category) => category.key)}
                  name={name}
                />
              )}
            </Section>

            <Section
              title="At another threshold"
              hint="What this run would have settled at each threshold, from the answers it holds. Above the threshold the run used, a ticket whose settle falls below the bar moves on to messages Jev was never asked about; those are counted as not known rather than as unsettled."
            >
              <Table
                head={[
                  'Threshold',
                  'Settled',
                  'Not known',
                  'Right',
                  ...report.categories.map((category) => name(category.key, '')),
                ]}
              >
                {report.sweep.map((row) => (
                  <Row key={row.threshold}>
                    <Cell>
                      {row.threshold.toFixed(2)}
                      {row.inForce ? (
                        <span className="ms-2">
                          <Badge tone="info">Used</Badge>
                        </span>
                      ) : null}
                    </Cell>
                    <Cell>{rate(row.settled, report.total.judged)}</Cell>
                    <Cell>{row.unasked}</Cell>
                    <Cell>
                      <Sampled estimate={row.jev} />
                    </Cell>
                    {row.byCategory.map((category) => (
                      <Cell key={category.key}>
                        <Sampled estimate={category.precision} />
                      </Cell>
                    ))}
                  </Row>
                ))}
              </Table>
            </Section>

            {report.filed.length > 0 ? (
              <Section
                title="Filed by Jev"
                hint="Tickets Jev wrote a category to in answer to this run's messages, and how many a person has changed since. A person who agrees changes nothing, so a ticket nobody changed may simply be one nobody looked at."
              >
                <Table head={['Category', 'Filed', 'Changed by a person', 'Changed to']}>
                  {report.filed.map((row) => (
                    <Row key={row.key ?? 'none'}>
                      <Cell>{name(row.key, 'No category')}</Cell>
                      <Cell>{row.filed}</Cell>
                      <Cell>{rate(row.changed, row.filed)}</Cell>
                      <Cell>
                        {row.changedTo.length === 0
                          ? '—'
                          : row.changedTo
                              .map((to) => `${name(to.key, 'No category')} (${to.count})`)
                              .join(', ')}
                      </Cell>
                    </Row>
                  ))}
                </Table>
              </Section>
            ) : null}

            <Section
              title="To label"
              hint="Tickets nobody has labelled and nothing has filed. They are chosen by what Jev settled on, so a rare category gets labels too, and from the tickets it never settled once Jev can no longer be asked about them, so recall has misses to count — but the list does not say which, so each label is the person's own reading of the ticket. Open one and choose its category in the Category select: a real change, which runs the rules keyed on the category and, before a first reply, chooses the SLA policy again, as any change does. There is no way yet to record that a ticket fits none of the categories, so leave one like that unlabelled."
            >
              {/* Empty when every ticket was written to first, as in apply
                  before Jev has missed anything: no stratum can take a label. */}
              {report.sample.length > 0 ? (
                <div className="mb-3">
                  <Table head={['Jev settled on', 'Labelled']}>
                    {report.sample.map((stratum) => (
                      <Row key={stratum.key ?? 'unsettled'}>
                        <Cell>{name(stratum.key, 'Never settled')}</Cell>
                        <Cell>
                          {stratum.key === null
                            ? stratum.labelled
                            : `${stratum.labelled} of ${LABELS_WANTED} wanted`}
                        </Cell>
                      </Row>
                    ))}
                  </Table>
                </div>
              ) : null}
              {report.toLabel.length === 0 ? (
                <Quiet>Nothing in this run is waiting for a label.</Quiet>
              ) : (
                <ul className="flex flex-wrap gap-3">
                  {report.toLabel.map((ticket) => (
                    <li key={ticket.conversationId} className="flex items-center gap-1">
                      <ChannelBadge channel={ticket.channel} showLabel={false} />
                      <Link
                        href={`/inbox/${ticket.number}`}
                        className="text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
                      >
                        #{ticket.number}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <p className="max-w-3xl text-xs text-(--color-text-tertiary)">
              Not judged, and in no figure above: {report.outOfPlay.owned} owned by a person, a rule
              or a form before Jev was asked; {report.outOfPlay.settled_elsewhere} settled outside
              this run, under another version of the question, in the other mode or by a
              backfill&rsquo;s filing; {report.outOfPlay.capped} capped; {report.outOfPlay.failed}{' '}
              whose every call failed. {report.writtenFirst} judged ticket
              {report.writtenFirst === 1 ? ' was' : 's were'} written to by Jev, a rule or a form
              before anybody labelled {report.writtenFirst === 1 ? 'it' : 'them'}, and{' '}
              {report.writtenFirst === 1 ? 'is' : 'are'} in no rate, {report.labelledAfterWrite}{' '}
              labelled since: agreeing with what was written leaves no label to grade.
            </p>
          </>
        )
      ) : null}
    </div>
  );
}

function QuestionRow({ question, current }: { question: RunQuestion; current: boolean }) {
  const href = `/reports/category-ai?${new URLSearchParams({
    label: question.runLabel,
    q: question.fingerprint,
    mode: question.mode,
  }).toString()}`;
  return (
    <Row>
      <Cell>
        <Link
          href={href}
          className="text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
        >
          {question.runLabel}
        </Link>
        {current ? (
          <span className="ms-2">
            <Badge tone="info">Showing</Badge>
          </span>
        ) : null}
      </Cell>
      <Cell>
        <code className="text-xs">{question.fingerprint.slice(0, 10)}</code>
      </Cell>
      <Cell>{question.mode}</Cell>
      <Cell>{question.tickets}</Cell>
      <Cell>{question.rows}</Cell>
      <Cell className="whitespace-nowrap">
        {formatDateTime(question.firstMessageAt)} – {formatDateTime(question.lastMessageAt)}
      </Cell>
      <Cell className="whitespace-nowrap">{formatDateTime(question.lastWrittenAt)}</Cell>
    </Row>
  );
}

function SliceRow({ slice }: { slice: Slice }) {
  return (
    <Row>
      <Cell>
        {slice.channel === null ? (
          <b>All channels</b>
        ) : (
          <span className="flex items-center gap-2">
            <ChannelBadge channel={slice.channel} showLabel={false} />
            {channelLabel(slice.channel)}
          </span>
        )}
      </Cell>
      <Cell>{slice.tickets}</Cell>
      <Cell>{slice.judged}</Cell>
      <Cell>{rate(slice.settled, slice.judged)}</Cell>
      <Cell>{rate(slice.settledOnFirst, slice.settled)}</Cell>
      <Cell>{rate(slice.unknowns, slice.answers)}</Cell>
      <Cell>{slice.labelled}</Cell>
      <Cell>
        <Sampled estimate={slice.jev} />
      </Cell>
      <Cell>
        <Sampled estimate={slice.rules} />
      </Cell>
      <Cell>{rate(slice.agree, slice.comparable)}</Cell>
    </Row>
  );
}

function Confusion({
  cells,
  keys,
  name,
}: {
  cells: { label: string | null; settled: string | null; count: number }[];
  keys: string[];
  name: (key: string | null, none: string) => string;
}) {
  const count = (label: string | null, settled: string | null) =>
    cells.find((cell) => cell.label === label && cell.settled === settled)?.count ?? 0;
  // Only the rows somebody labelled: an empty row is a category nobody chose.
  const rows = [...keys, null].filter((label) =>
    cells.some((cell) => cell.label === label && cell.count > 0),
  );
  const columns = [...keys, null];
  return (
    <Table
      head={[
        <span key="corner" className="flex items-center gap-1">
          Person chose
          <InfoTip label="Person chose">
            Each row is the category a person chose; No category is a person clearing one. Each
            column is what Jev settled on.
          </InfoTip>
        </span>,
        ...columns.map((settled) => name(settled, 'Not settled')),
      ]}
    >
      {rows.map((label) => (
        <Row key={label ?? 'none'}>
          <Cell>{name(label, 'No category')}</Cell>
          {columns.map((settled) => {
            const value = count(label, settled);
            return (
              <Cell key={settled ?? 'none'} className={label === settled ? 'font-semibold' : ''}>
                {value === 0 ? <span className="text-(--color-text-tertiary)">0</span> : value}
              </Cell>
            );
          })}
        </Row>
      ))}
    </Table>
  );
}

/**
 * A rate over labelled tickets with its sample always beside it: the criterion
 * is a precision on a stated count. The percentage is the weighted estimate,
 * so it can differ from the two counts beside it; below ten there is no
 * percentage worth printing.
 */
function Sampled({ estimate }: { estimate: Estimate }) {
  if (estimate.of === 0) return <>—</>;
  // One line, so a phone scrolls the table rather than stacking the rate.
  return (
    <span className="whitespace-nowrap">
      {estimate.of >= 10 ? `${percent(estimate)} · ` : ''}
      <span className="text-(--color-text-secondary)">
        {estimate.right} of {estimate.of}
      </span>
    </span>
  );
}

function percent(estimate: Estimate): string {
  if (estimate.rate === null) return '—';
  if (estimate.of < 10) return `${estimate.right} of ${estimate.of}`;
  return `${Math.round(100 * estimate.rate)}%`;
}
