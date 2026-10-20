import { Stat } from '@/components/charts';
import { ago, formatRelative } from '@/lib/format';
import type { systemHealth } from '@/lib/reports/live';

import { Section } from './section';

export function Health({
  health,
  now,
}: {
  health: Awaited<ReturnType<typeof systemHealth>>;
  now: Date;
}) {
  // Further behind than tonight's run explains: the threshold `/reports/csat`
  // warns at, so the tile turns amber on the day that page does. Said in the
  // hint as well, because the amber is never the only signal.
  const behind = health.rollupDaysBehind ?? 0;
  const stalled = behind > 1;
  // A day with no count beside it is `metrics_daily`'s newest, which holds only
  // the days somebody worked: a quiet day and a missed night read the same
  // there, so the tile says what the day is rather than vouching for the run.
  const fromFigures = health.rollupDay !== null && health.rollupDaysBehind === null;
  const when = health.rollupComputedAt ? ago(formatRelative(health.rollupComputedAt, now)) : null;
  const rollupHint = !when
    ? 'The rollup has not computed a day yet'
    : fromFigures
      ? `Last day with figures, written ${when} · any day after it may be quiet or missed`
      : `Computed ${when}${stalled ? ` · the ${behind} days after ${health.rollupDay} are not rolled up` : ''}`;

  return (
    <Section
      title="Behind the scenes"
      hint="Every reply, every webhook and every one of these figures is produced by the worker. When it stops, nothing else on this page looks wrong — which is why it is here."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Jobs waiting"
          value={health.jobsPending.toLocaleString('en-GB')}
          hint={
            health.oldestPendingSince
              ? `Oldest queued ${ago(formatRelative(health.oldestPendingSince, now))} · ${health.jobsProcessing} running`
              : `${health.jobsProcessing} running`
          }
          tone={health.jobsPending > 100 ? 'caution' : undefined}
        />
        <Stat
          label="Jobs given up on"
          explain="Work that used every retry and stopped — a reply that never sent, a webhook not fully handled. Nothing retries it on its own, so any number above zero is something that did not happen."
          value={health.jobsDead.toLocaleString('en-GB')}
          hint={`${health.jobsFailed.toLocaleString('en-GB')} retrying`}
          tone={health.jobsDead > 0 ? 'critical' : undefined}
        />
        <Stat
          label="Webhooks unprocessed"
          value={health.webhooksUnprocessed.toLocaleString('en-GB')}
          hint={
            health.oldestWebhookSince
              ? `Oldest received ${ago(formatRelative(health.oldestWebhookSince, now))}`
              : 'Everything received has been handled'
          }
          tone={health.webhooksUnprocessed > 50 ? 'caution' : undefined}
        />
        <Stat
          label="Reports cover up to"
          explain={
            fromFigures
              ? 'Until the nightly rollup has recorded a day it computed, this is the newest day with any figures. A day nobody worked has none, so a quiet day and a missed night look the same here, and the customer satisfaction report can name a different day.'
              : "The newest day the nightly rollup has finished computing, whether or not anybody worked it: the day the customer satisfaction report counts to. It moves to yesterday when the nightly run reaches it, so a day older than the one before yesterday means a night's run was missed."
          }
          value={health.rollupDay ?? '—'}
          hint={rollupHint}
          tone={!health.rollupComputedAt || stalled ? 'caution' : undefined}
        />
      </div>
    </Section>
  );
}
