import Link from 'next/link';
import { Badge, Cell, EmptyState, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { formatRelative } from '@/lib/format';
import type { agentLoad } from '@/lib/reports/live';
import { formatDuration } from '@/lib/reports/queries';

import { Section } from './section';

export function AgentLoad({
  agentRows,
  now,
}: {
  agentRows: Awaited<ReturnType<typeof agentLoad>>;
  now: Date;
}) {
  return (
    <Section
      title="Who is holding what"
      hint="Live, and only the tickets still open. An agent with an empty queue is listed too — an empty column and a missing row look the same otherwise."
      actions={
        /* The control lives on one page rather than two. This table is a
             wallboard — it answers who is loaded; setting somebody's
             availability is a decision, and it belongs with the reason for
             making it. */
        <Link
          href="/reports/team"
          className="rounded-md border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--muted)]"
        >
          Set availability
        </Link>
      }
    >
      {agentRows.length === 0 ? (
        <EmptyState title="No active agents" hint="Invite the team from Settings → Agents." />
      ) : (
        <Table
          head={[
            'Agent',
            'Presence',
            <>
              Open{' '}
              <InfoTip label="Open">
                Tickets assigned to them that are still open or pending — the same count the
                assignment engine measures a cap against, which is why a second number appears
                beside it for an agent who has one.
              </InfoTip>
            </>,
            <>
              Waiting on us{' '}
              <InfoTip label="Waiting on us">
                Of those, the ones where the customer spoke last and has had no reply since.
              </InfoTip>
            </>,
            <>
              Breached{' '}
              <InfoTip label="Breached">
                Past a first-response or resolution target already, counted in the working hours the
                ticket&rsquo;s SLA policy uses rather than in wall-clock time.
              </InfoTip>
            </>,
            <>
              Longest wait{' '}
              <InfoTip label="Longest wait">
                How long their oldest unanswered customer message has been sitting there.
              </InfoTip>
            </>,
          ]}
        >
          {agentRows.map((agent) => (
            <Row key={agent.id}>
              <Cell className="font-medium">{agent.name}</Cell>
              <Cell>
                <Badge tone={presenceTone(agent.presence)}>{agent.presence}</Badge>
                {agent.lastSeenAt && agent.presence !== 'online' ? (
                  <span className="ms-2 text-xs text-[var(--muted-foreground)]">
                    {formatRelative(agent.lastSeenAt)}
                  </span>
                ) : null}
              </Cell>
              <Cell>
                {agent.open.toLocaleString('en-GB')}
                {/* Shown as a fraction so a full agent is legible at a glance:
                      "8 / 8" is the reason the queue is not draining, and it
                      reads as an explanation where a bare 8 reads as a total. */}
                {agent.maxOpen !== null ? (
                  <span
                    className={
                      agent.open >= agent.maxOpen
                        ? 'ms-1 text-xs font-medium text-amber-600'
                        : 'ms-1 text-xs text-[var(--muted-foreground)]'
                    }
                  >
                    / {agent.maxOpen}
                  </span>
                ) : null}
              </Cell>
              <Cell>{agent.awaitingReply.toLocaleString('en-GB')}</Cell>
              <Cell>
                {agent.breached > 0 ? (
                  <Badge tone="danger">{agent.breached}</Badge>
                ) : (
                  <span className="text-[var(--muted-foreground)]">—</span>
                )}
              </Cell>
              <Cell className="text-[var(--muted-foreground)]">
                {agent.oldestWaitingSince
                  ? formatDuration(
                      Math.round((now.getTime() - agent.oldestWaitingSince.getTime()) / 1000),
                    )
                  : '—'}
              </Cell>
            </Row>
          ))}
        </Table>
      )}
    </Section>
  );
}

function presenceTone(presence: 'online' | 'away' | 'offline') {
  return presence === 'online' ? 'success' : presence === 'away' ? 'warning' : 'neutral';
}
