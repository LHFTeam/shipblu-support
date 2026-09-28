import Link from 'next/link';
import { Stat } from '@/components/charts';
import { formatDateTime } from '@/lib/format';
import type { agentLoad, queueSnapshot } from '@/lib/reports/live';
import { formatDuration } from '@/lib/reports/queries';

import { Section } from './section';

export function RightNow({
  queue,
  now,
  online,
  agentRows,
}: {
  queue: Awaited<ReturnType<typeof queueSnapshot>>;
  now: Date;
  online: number;
  agentRows: Awaited<ReturnType<typeof agentLoad>>;
}) {
  return (
    <Section
      title="Right now"
      hint="Open and pending tickets, read live. Resolved and closed work is not counted."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:col-span-2">
          <p className="text-xs text-[var(--muted-foreground)]">Open right now</p>
          <p className="mt-1 text-5xl font-semibold [font-variant-numeric:proportional-nums]">
            {(queue.open + queue.pending).toLocaleString('en-GB')}
          </p>
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">
            {queue.open.toLocaleString('en-GB')} open · {queue.pending.toLocaleString('en-GB')}{' '}
            pending
            {queue.onHold > 0
              ? ` · ${queue.onHold.toLocaleString('en-GB')} with the clock stopped`
              : ''}
          </p>
          <p className="mt-3">
            <Link
              href="/inbox?status=unresolved"
              className="text-xs text-brand-600 hover:underline"
            >
              Open the inbox →
            </Link>
          </p>
        </div>

        <Stat
          label="Waiting on us"
          value={queue.awaitingReply.toLocaleString('en-GB')}
          explain="Open tickets where the customer spoke last — they have written and nobody has replied since. It is one definition, shared by every figure on this page that says waiting."
          hint={`${queue.awaitingFirstReply.toLocaleString('en-GB')} never answered`}
          tone={queue.awaitingReply > 0 ? 'caution' : undefined}
        />
        <Stat
          label="Unassigned"
          value={queue.unassigned.toLocaleString('en-GB')}
          hint={queue.unassigned > 0 ? 'Nobody has picked these up' : 'Everything has an owner'}
          tone={queue.unassigned > 0 ? 'caution' : undefined}
        />
        <Stat
          label="SLA breached"
          value={queue.breached.toLocaleString('en-GB')}
          hint="First response or resolution, already past due"
          tone={queue.breached > 0 ? 'critical' : undefined}
        />
        <Stat
          label="Due within the hour"
          value={queue.dueWithinHour.toLocaleString('en-GB')}
          hint="Still savable"
          tone={queue.dueWithinHour > 0 ? 'caution' : undefined}
        />
        <Stat
          label="Longest wait"
          value={
            queue.oldestWaitingSince
              ? formatDuration(
                  Math.round((now.getTime() - queue.oldestWaitingSince.getTime()) / 1000),
                )
              : '—'
          }
          hint={
            queue.oldestWaitingSince
              ? `Since ${formatDateTime(queue.oldestWaitingSince)}`
              : 'Nothing is waiting on a reply'
          }
        />
        <Stat
          label="Agents online"
          value={`${online} / ${agentRows.length}`}
          hint="Signed in and active"
        />
      </div>
    </Section>
  );
}
