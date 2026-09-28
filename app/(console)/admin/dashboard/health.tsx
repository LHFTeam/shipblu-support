import { Stat } from '@/components/charts';
import { formatRelative } from '@/lib/format';
import type { systemHealth } from '@/lib/reports/live';

import { Section } from './section';

export function Health({ health }: { health: Awaited<ReturnType<typeof systemHealth>> }) {
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
              ? `Oldest queued ${formatRelative(health.oldestPendingSince)} ago · ${health.jobsProcessing} running`
              : `${health.jobsProcessing} running`
          }
          tone={health.jobsPending > 100 ? 'caution' : undefined}
        />
        <Stat
          label="Jobs given up on"
          explain="Work that used every retry and stopped — a reply that never sent, a webhook never handled. Nothing retries it on its own, so any number above zero is something that did not happen."
          value={health.jobsDead.toLocaleString('en-GB')}
          hint={`${health.jobsFailed.toLocaleString('en-GB')} retrying`}
          tone={health.jobsDead > 0 ? 'critical' : undefined}
        />
        <Stat
          label="Webhooks unprocessed"
          value={health.webhooksUnprocessed.toLocaleString('en-GB')}
          hint={
            health.oldestWebhookSince
              ? `Oldest received ${formatRelative(health.oldestWebhookSince)} ago`
              : 'Everything received has been handled'
          }
          tone={health.webhooksUnprocessed > 50 ? 'caution' : undefined}
        />
        <Stat
          label="Reports cover up to"
          value={health.lastRollupDay ?? '—'}
          hint={
            health.lastRollupAt
              ? `That day's figures were written ${formatRelative(health.lastRollupAt)} ago`
              : 'The nightly job has never run'
          }
          tone={health.lastRollupAt ? undefined : 'caution'}
        />
      </div>
    </Section>
  );
}
