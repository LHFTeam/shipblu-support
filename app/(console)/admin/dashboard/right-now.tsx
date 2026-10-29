import Link from 'next/link';
import { Stat } from '@/components/charts';
import { Card } from '@/components/ui';
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
        <Card padded={false} className="p-4 sm:col-span-2">
          <p className="text-xs text-(--color-text-secondary)">Open right now</p>
          <p className="mt-1 text-5xl font-semibold [font-variant-numeric:proportional-nums]">
            {(queue.open + queue.pending).toLocaleString('en-GB')}
          </p>
          <p className="mt-2 text-xs text-(--color-text-secondary)">
            {queue.open.toLocaleString('en-GB')} open · {queue.pending.toLocaleString('en-GB')}{' '}
            pending
            {queue.onHold > 0
              ? ` · ${queue.onHold.toLocaleString('en-GB')} with the clock stopped`
              : ''}
          </p>
          <p className="mt-3">
            <Link
              href="/inbox?status=unresolved"
              className="text-xs text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
            >
              Open the inbox →
            </Link>
          </p>
        </Card>

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
          explain="Open tickets nobody holds. On a channel that routes by category, a new ticket is held — assigned to nobody — until its category settles or its routing window ends. It then moves to the group its category routes to, or stays in the channel’s default group when no category settled or its category routes nowhere else. Those are counted here as being routed, the ones the inbox marks “Routing until …” or “Routing…”: nobody is meant to have picked them up yet."
          hint={unassignedHint(queue)}
          // Amber for the work nobody has picked up, not for the tickets held
          // so that nobody does: a queue of nothing but held tickets is the
          // router doing its job.
          tone={queue.unassigned - queue.routing > 0 ? 'caution' : undefined}
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

/**
 * What the unassigned are. The held ones named apart, because "nobody has
 * picked these up" is false of a ticket being routed — it is unassigned by
 * design until the router sends it to a group — and an admin reading the tile
 * would otherwise go and assign the tickets the router is about to move.
 */
function unassignedHint({ unassigned, routing }: { unassigned: number; routing: number }): string {
  if (unassigned === 0) return 'Everything has an owner';
  if (routing === 0) return 'Nobody has picked these up';
  if (routing === unassigned) {
    return 'Being routed — held until their category settles or the window ends';
  }
  return `${routing.toLocaleString('en-GB')} being routed · ${(unassigned - routing).toLocaleString('en-GB')} nobody has picked up`;
}
