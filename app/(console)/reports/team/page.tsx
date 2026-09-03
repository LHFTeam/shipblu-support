import Link from 'next/link';
import { Badge, Cell, EmptyState, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { requirePermission } from '@/lib/auth/guard';
import { formatRelative } from '@/lib/format';
import { loadPresencePolicy } from '@/lib/presence/policy';
import { agentLoad } from '@/lib/reports/live';
import { AvailabilityControl } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Who is at their desk, right now, and the one control that changes it.
 *
 * The live counterpart to `/reports/agents`, and separate from it on purpose:
 * that page reads the nightly rollup and answers "how did last week go", this
 * one reads the live tables and answers "who can take the next ticket". Putting
 * a control on a page whose numbers are a day old would invite acting on
 * yesterday's picture.
 *
 * Its own permission rather than `report.agents`, because reading what somebody
 * did and changing where the next ticket goes are different things to hand out
 * — see `agent.availability`.
 *
 * Everything here comes from `agentLoad()`, the same function the admin
 * dashboard renders, so the two cannot disagree about who is available. This
 * page adds why, and what to do about it.
 */
export default async function TeamAvailabilityPage() {
  await requirePermission('agent.availability');

  const [team, policy] = await Promise.all([agentLoad(), loadPresencePolicy()]);

  const online = team.filter((agent) => agent.presence === 'online').length;
  const away = team.filter((agent) => agent.presence === 'away').length;

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title="Team availability"
        description={describePolicy(policy)}
        actions={
          <Link
            href="/reports/agents"
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-sm hover:bg-[var(--muted)]"
          >
            Agent productivity
          </Link>
        }
      />

      <p className="mb-4 text-sm text-[var(--muted-foreground)]">
        {online} accepting work, {away} away, {team.length - online - away} offline.
      </p>

      {team.length === 0 ? (
        <EmptyState title="No active agents" />
      ) : (
        <Table
          head={[
            'Agent',
            'Availability',
            'Last activity',
            'Open',
            'Awaiting reply',
            'Breached',
            '',
          ]}
        >
          {team.map((agent) => (
            <Row key={agent.id}>
              <Cell>{agent.name}</Cell>
              <Cell>
                <span className="flex items-center gap-1.5">
                  <Badge
                    tone={
                      agent.presence === 'online'
                        ? 'success'
                        : agent.presence === 'away'
                          ? 'warning'
                          : 'neutral'
                    }
                  >
                    {agent.presence}
                  </Badge>
                  {/* The reason is the whole point of the column. "Away"
                      alone leaves a supervisor unable to tell somebody who
                      stepped out from somebody a timer parked from somebody
                      another supervisor parked ten minutes ago. */}
                  {agent.offReason ? (
                    <span className="text-xs opacity-50">{reasonLabel(agent.offReason)}</span>
                  ) : null}
                </span>
              </Cell>
              <Cell>
                <span className="text-xs opacity-60">
                  {agent.lastInputAt ? formatRelative(agent.lastInputAt) : '—'}
                </span>
              </Cell>
              <Cell>
                {agent.open}
                {agent.maxOpen !== null ? (
                  <span className="opacity-40"> / {agent.maxOpen}</span>
                ) : null}
              </Cell>
              <Cell>{agent.awaitingReply}</Cell>
              <Cell>
                {agent.breached > 0 ? (
                  <Badge tone="danger">{agent.breached}</Badge>
                ) : (
                  <span className="opacity-40">0</span>
                )}
              </Cell>
              <Cell>
                <AvailabilityControl
                  agentId={agent.id}
                  name={agent.name}
                  accepting={agent.accepting}
                />
              </Cell>
            </Row>
          ))}
        </Table>
      )}

      <div className="mt-4 flex items-start gap-1.5 text-xs text-[var(--muted-foreground)]">
        <span>
          Setting somebody to not accepting stops new tickets routing to them. It never moves the
          tickets they already hold, and it does not sign them out.
        </span>
        <InfoTip label="What an agent sees">
          They keep their own switch and can turn it back on — this is a way to cover the queue, not
          a lock. What it does guarantee is that returning to the keyboard will not silently undo
          it, which is what happens to an away the idle timer set.
        </InfoTip>
      </div>
    </div>
  );
}

function reasonLabel(reason: 'self' | 'idle' | 'supervisor'): string {
  return reason === 'self'
    ? 'their own switch'
    : reason === 'idle'
      ? 'idle'
      : 'set by a supervisor';
}

/** Says what the automation will do, so a supervisor is not guessing at it. */
function describePolicy(policy: {
  autoAwayAfterMins: number | null;
  autoSignoutAfterMins: number | null;
}): string {
  const parts: string[] = [];

  if (policy.autoAwayAfterMins !== null) {
    parts.push(`marked away after ${policy.autoAwayAfterMins} minutes without input`);
  }
  if (policy.autoSignoutAfterMins !== null) {
    parts.push(`signed out after ${policy.autoSignoutAfterMins}`);
  }

  if (parts.length === 0) {
    return 'Live, from the console connection and the last input in it. No idle timers are switched on.';
  }

  return `Live, from the last input in the console. Agents are ${parts.join(', and ')}.`;
}
