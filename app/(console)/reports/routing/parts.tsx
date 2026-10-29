import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChannelBadge } from '@/components/channel';
import { InfoTip } from '@/components/tooltip';
import { Badge, Cell, Row, Table } from '@/components/ui';
import { formatDuration } from '@/lib/reports/queries';
import { ROUTING_OUTCOMES, type RoutingOutcome } from '@/lib/routing/decide';
import { ROUTING_MODE_LABELS, ROUTING_OUTCOME_LABELS } from '@/lib/routing/mode-copy';
import {
  decidedFirst,
  GRACE_IN_WORDS,
  routerDecided,
  type DecisionTiming,
  type FallbackReasons,
  type ListedTicket,
  type ReportChannel,
  type RoutingChannel,
  type RoutingSlice,
  type ShadowComparison,
  type StillUnassigned,
} from '@/lib/routing/report';
import { rate } from '../report-parts';
import { STRATEGY_LABELS } from '@/lib/assignment/strategy-copy';

/**
 * The routing report's tables, apart from the page so the page reads as the
 * order of its sections. Server components: every figure is a string by the
 * time it reaches the browser.
 */

/**
 * A percentile from this many decisions up. Below it the 90th is one or two
 * tickets wide — the rule `rate()` keeps for a percentage, applied to the
 * tail, where it bites first.
 */
const P90_FROM = 10;

/** A duration Postgres measured, rounded first: `formatDuration` prints "37.4s" for 37.4. */
function duration(seconds: number | null): string {
  return seconds === null ? '—' : formatDuration(Math.round(seconds));
}

const link =
  'text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline whitespace-nowrap';

/** A channel row by its badge and name, or the line every deleted channel's rows share. */
function ChannelName({ type, name }: { type: string | null; name: string | null }) {
  if (name === null) {
    return <span className="text-(--color-text-secondary)">A deleted channel</span>;
  }
  return (
    <span className="flex items-center gap-2">
      {type ? <ChannelBadge channel={type} showLabel={false} /> : null}
      <span dir="auto">{name}</span>
    </span>
  );
}

/** A ticket number as a link into the inbox, which applies the reader's own visibility. */
export function TicketLink({ ticket }: { ticket: Pick<ListedTicket, 'number' | 'channel'> }) {
  return (
    <span className="flex items-center gap-1">
      <ChannelBadge channel={ticket.channel} showLabel={false} />
      <Link href={`/inbox/${ticket.number}`} className={link}>
        #{ticket.number}
      </Link>
    </span>
  );
}

/** A list of them, saying how many more there are than it names. */
export function TicketLinks({ tickets, total }: { tickets: ListedTicket[]; total: number }) {
  return (
    <ul className="flex flex-wrap items-center gap-3 text-sm">
      {tickets.map((ticket) => (
        <li key={ticket.conversationId}>
          <TicketLink ticket={ticket} />
        </li>
      ))}
      {total > tickets.length ? (
        <li className="text-xs text-(--color-text-secondary)">and {total - tickets.length} more</li>
      ) : null}
    </ul>
  );
}

function modeNow(channelId: string | null, modes: Map<string, RoutingChannel>): string {
  if (channelId === null) return '—';
  const channel = modes.get(channelId);
  if (!channel) return '—';
  return channel.isActive
    ? ROUTING_MODE_LABELS[channel.mode]
    : `${ROUTING_MODE_LABELS[channel.mode]}, inactive`;
}

/**
 * The order the outcome columns are read in, which is not the enum's: the
 * router's own four first, in the order the shares' denominator names them,
 * then the holds a person or a rule ended first, then the tickets nobody
 * routed. A `Record` rather than a list, so an outcome added to the enum fails
 * to compile here instead of quietly missing from the table.
 */
const COLUMN_ORDER: Record<RoutingOutcome, number> = {
  category: 0,
  no_route_for_category: 1,
  fallback: 2,
  taken: 3,
  manual: 4,
  rule: 5,
  not_open: 6,
  released: 7,
};
const OUTCOME_COLUMNS = [...ROUTING_OUTCOMES].sort((a, b) => COLUMN_ORDER[a] - COLUMN_ORDER[b]);

/**
 * One line per channel row that started routing in the range, live or shadow,
 * and a line for every active channel in that mode now that had nothing enter:
 * an empty table reads as a page not finished, and a missing line as a
 * channel nobody switched on.
 *
 * Two tables, not one: where each channel's tickets stand with the three
 * shares read off them, then the decisions by outcome. As one table it was
 * seventeen columns, twice the width of a desktop's content column, and the
 * shares — what a reader comes for — were the part scrolled out of sight.
 */
export function OutcomeTable({
  slices,
  shadow,
  idleChannels,
  modes,
}: {
  slices: RoutingSlice[];
  shadow: boolean;
  /** Active channels in this table's mode now with no line in the range. */
  idleChannels: RoutingChannel[];
  modes: Map<string, RoutingChannel>;
}) {
  const head: ReactNode[] = [
    'Channel',
    'Mode now',
    'Entered',
    'Decided',
    'Deciding now',
    <span key="stranded" className="flex items-center gap-1">
      Stranded
      <InfoTip label="Stranded">
        Undecided {GRACE_IN_WORDS} after its window ended, when the hold&rsquo;s grace runs out.
        Should always be 0; every one still open, whatever the range, is listed under Now.
      </InfoTip>
    </span>,
    <span key="fallback" className="flex items-center gap-1">
      Ran out, of the router&rsquo;s
      <InfoTip label="Ran out, of the router’s">
        Window ran out, over the decisions the router made itself: Routed, Routes to no other group,
        Window ran out and Already taken. Not over every decision, or a channel whose holds a rule
        always ends first would read as never running out.
      </InfoTip>
    </span>,
    'Taken, of the router’s',
    <span key="first" className="flex items-center gap-1">
      Decided first
      <InfoTip label="Decided first">
        A person or a rule decided where the ticket goes before the router did, over every decision.
        What explains a channel where the router decides little.
      </InfoTip>
    </span>,
  ];
  const columns = head.length;
  const key = (slice: RoutingSlice) => `${slice.channelId ?? 'deleted'}:${String(slice.shadow)}`;

  return (
    <div className="space-y-4">
      <Table head={head}>
        {slices.map((slice) => {
          const router = routerDecided(slice.outcomes);
          return (
            <Row key={key(slice)}>
              <Cell>
                <ChannelName type={slice.channelType} name={slice.channelName} />
              </Cell>
              <Cell className="whitespace-nowrap">{modeNow(slice.channelId, modes)}</Cell>
              <Cell>{slice.entered}</Cell>
              <Cell>{slice.decided}</Cell>
              <Cell>{slice.deciding}</Cell>
              <Cell>{slice.stranded}</Cell>
              <Cell>{rate(slice.outcomes.fallback, router)}</Cell>
              <Cell>{shadow ? '—' : rate(slice.outcomes.taken, router)}</Cell>
              <Cell>{rate(decidedFirst(slice.outcomes), slice.decided)}</Cell>
            </Row>
          );
        })}
        {idleChannels.map((channel) => (
          <Row key={`idle:${channel.id}`}>
            <Cell>
              <ChannelName type={channel.type} name={channel.name} />
            </Cell>
            <Cell className="whitespace-nowrap">{ROUTING_MODE_LABELS[channel.mode]}</Cell>
            <td
              colSpan={columns - 2}
              className="px-(--density-row-x) py-(--density-cell-y) text-(--color-text-secondary)"
            >
              Nothing entered routing in this window.
            </td>
          </Row>
        ))}
      </Table>

      {/* A channel with nothing decided has no counts to show: the line above
          already says so. */}
      {slices.length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs font-medium text-(--color-text-secondary)">
            Decided, by outcome
          </h3>
          <Table
            head={['Channel', ...OUTCOME_COLUMNS.map((outcome) => ROUTING_OUTCOME_LABELS[outcome])]}
          >
            {slices.map((slice) => (
              <Row key={key(slice)}>
                <Cell>
                  <ChannelName type={slice.channelType} name={slice.channelName} />
                </Cell>
                {OUTCOME_COLUMNS.map((outcome) => (
                  <Cell key={outcome}>
                    {count(slice.outcomes[outcome], shadow && outcome === 'taken')}
                  </Cell>
                ))}
              </Row>
            ))}
          </Table>
        </div>
      ) : null}
    </div>
  );
}

/** `taken` never happens on a shadow row (`decide`), so its cell is a dash, not a zero. */
function count(value: number, impossible: boolean): ReactNode {
  if (impossible) return '—';
  return value === 0 ? <span className="text-(--color-text-tertiary)">0</span> : value;
}

/**
 * A line's channel with whether it was live or a would-be, said in words
 * beside it — in one cell rather than a column of its own, which pushed the
 * timing table past a desktop's content column and wrapped every name.
 */
function ChannelAndMode({ line }: { line: ReportChannel }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <ChannelName type={line.channelType} name={line.channelName} />
      {line.shadow ? <Badge tone="info">Shadow</Badge> : <Badge tone="success">Live</Badge>}
    </span>
  );
}

export function TimingTable({ rows }: { rows: DecisionTiming[] }) {
  return (
    <Table
      head={[
        'Channel',
        'Window',
        <span key="settled" className="flex items-center gap-1">
          Category settled
          <InfoTip label="Category settled">
            Decisions made on a category — Routed and Routes to no other group — and how long after
            the ticket entered routing the router recorded each. A decision completed after its
            caller died counts from when it was first made, not from the completion.
          </InfoTip>
        </span>,
        'Median',
        '90th percentile',
        'Within the window',
        <span key="first" className="flex items-center gap-1">
          A person or rule first
          <InfoTip label="A person or rule first">
            Holds a person or a rule ended before the router decided, and the median time they took.
            Kept apart: it measures them, not the router.
          </InfoTip>
        </span>,
        <span key="lag" className="flex items-center gap-1">
          Settle job late by
          <InfoTip label="Settle job late by">
            How far past the window&rsquo;s end the settle job recorded the decisions it made, 90th
            percentile and worst. Past {GRACE_IN_WORDS} the hold had already lapsed, and the sweep
            could assign the ticket in the group it was leaving.
          </InfoTip>
        </span>,
        <span key="assigned" className="flex items-center gap-1">
          Routed, then assigned
          <InfoTip label="Routed, then assigned">
            Live tickets the router moved to a category&rsquo;s route group that somebody was
            assigned after the move, by anything — the rota, a person, a number&rsquo;s owner — and
            the median wait for the first assignment.
          </InfoTip>
        </span>,
      ]}
    >
      {rows.map((row) => (
        <Row key={`${row.channelId ?? 'deleted'}:${String(row.shadow)}`}>
          <Cell>
            <ChannelAndMode line={row} />
          </Cell>
          <Cell className="whitespace-nowrap">{minutes(row.windowMinutes)}</Cell>
          <Cell>{row.settled}</Cell>
          <Cell>{duration(row.settledP50)}</Cell>
          <Cell>{row.settled >= P90_FROM ? duration(row.settledP90) : '—'}</Cell>
          <Cell>{rate(row.settledInWindow, row.settled)}</Cell>
          <Cell className="whitespace-nowrap">
            {row.decidedFirst === 0
              ? '—'
              : `${row.decidedFirst} · median ${duration(row.decidedFirstP50)}`}
          </Cell>
          <Cell className="whitespace-nowrap">
            {row.settledByJob === 0
              ? '—'
              : row.settledByJob >= P90_FROM
                ? `90th ${duration(row.settleLagP90)} · worst ${duration(row.settleLagMax)}`
                : `${row.settledByJob} · worst ${duration(row.settleLagMax)}`}
          </Cell>
          <Cell className="whitespace-nowrap">
            {row.shadow
              ? '—'
              : row.routed === 0
                ? '—'
                : row.routedAssigned === 0
                  ? rate(row.routedAssigned, row.routed)
                  : `${rate(row.routedAssigned, row.routed)} · median ${duration(row.routedAssignedP50)}`}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function minutes(values: number[]): string {
  if (values.length === 0) return '—';
  return `${values.join(', ')} min`;
}

export function FallbackTable({ rows }: { rows: FallbackReasons[] }) {
  return (
    <Table
      head={[
        'Channel',
        'Window ran out',
        <span key="late" className="flex items-center gap-1">
          A category came later
          <InfoTip label="A category came later">
            Tickets something filed after the window ran out — the evidence that a longer window
            would have routed more. Split by who filed it, with the median time past the
            window&rsquo;s end; the rest were filed by a rule or a form.
          </InfoTip>
        </span>,
        'By Jev',
        'By a person',
        <span key="asked" className="flex items-center gap-1">
          Jev never asked
          <InfoTip label="Jev never asked">
            This and the next two say what Jev had answered when the window ran out. Never asked: no
            answer at all — a photo with no caption, or a job that had not run yet. Unsure: every
            answer was unknown or under the threshold, so a lower threshold might have routed it.
            Every call failed: no answer came back. A ticket Jev answered late counts as never asked
            here and as filed by Jev beside it; one in none of the three was answered some other
            way, such as past the classifier&rsquo;s cap.
          </InfoTip>
        </span>,
        'Jev unsure',
        'Every call failed',
      ]}
    >
      {rows.map((row) => (
        <Row key={`${row.channelId ?? 'deleted'}:${String(row.shadow)}`}>
          <Cell>
            <ChannelAndMode line={row} />
          </Cell>
          <Cell>{row.fallbacks}</Cell>
          <Cell>{rate(row.late, row.fallbacks)}</Cell>
          <Cell className="whitespace-nowrap">
            {row.lateJev === 0
              ? '0'
              : `${row.lateJev} · median ${duration(row.lateJevP50PastWindow)} late`}
          </Cell>
          <Cell className="whitespace-nowrap">
            {row.latePerson === 0
              ? '0'
              : `${row.latePerson} · median ${duration(row.latePersonP50PastWindow)} late`}
          </Cell>
          <Cell>{rate(row.notAsked, row.fallbacks)}</Cell>
          <Cell>{rate(row.unsure, row.fallbacks)}</Cell>
          <Cell>{rate(row.failed, row.fallbacks)}</Cell>
        </Row>
      ))}
    </Table>
  );
}

export function ShadowTable({ rows }: { rows: ShadowComparison[] }) {
  return (
    <Table
      head={[
        'Channel',
        <span key="move" className="flex items-center gap-1">
          Would move
          <InfoTip label="Would move">
            Tickets whose category routes to another group, which the router would have moved there.
            A person &ldquo;moved it&rdquo; when the last change of group an agent made after the
            would-be decision put it somewhere.
          </InfoTip>
        </span>,
        'A person moved it there',
        'Moved elsewhere',
        'Not moved',
        'Would keep',
        <span key="missed" className="flex items-center gap-1">
          A person moved it
          <InfoTip label="A person moved it">
            Tickets the router would have left where they were — their category routes to no other
            group, or the window ran out — that a person then moved: a route missed.
          </InfoTip>
        </span>,
        'Left where it was',
        <span key="first" className="flex items-center gap-1">
          Decided first
          <InfoTip label="Decided first">
            A person or a rule moved or assigned the ticket during the window, before the router
            recorded where it would have gone, so there is nothing to compare.
          </InfoTip>
        </span>,
      ]}
    >
      {rows.map((row) => (
        <Row key={row.channelId ?? 'deleted'}>
          <Cell>
            <ChannelName type={row.channelType} name={row.channelName} />
          </Cell>
          <Cell>{row.wouldMove}</Cell>
          <Cell>{rate(row.movedThere, row.wouldMove)}</Cell>
          <Cell>{rate(row.movedElsewhere, row.wouldMove)}</Cell>
          <Cell>{rate(row.notMoved, row.wouldMove)}</Cell>
          <Cell>{row.wouldKeep}</Cell>
          <Cell>{rate(row.missed, row.wouldKeep)}</Cell>
          <Cell>{rate(row.kept, row.wouldKeep)}</Cell>
          <Cell className="whitespace-nowrap">
            {row.manual} by a person · {row.rule} by a rule
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

/**
 * Routed tickets nobody holds, by the group each is in now and that group's
 * strategy. A `manual` group picks from its queue, so its tickets wait by
 * design: labelled, never warned about.
 */
export function UnassignedTable({ rows }: { rows: StillUnassigned[] }) {
  return (
    <Table head={['Group now', 'Assignment', 'Decision', 'Tickets', 'Waiting longest']}>
      {rows.map((row) => (
        <Row key={`${row.groupId ?? 'none'}:${row.outcome}`}>
          <Cell>
            {row.groupName === null ? (
              <span className="text-(--color-text-secondary)">No group</span>
            ) : (
              <span dir="auto">{row.groupName}</span>
            )}
          </Cell>
          <Cell className="whitespace-nowrap">
            {row.strategy === 'manual' ? (
              <Badge tone="neutral">Manual: picked from the queue</Badge>
            ) : row.strategy === null ? (
              '—'
            ) : (
              STRATEGY_LABELS[row.strategy]
            )}
          </Cell>
          <Cell className="whitespace-nowrap">{ROUTING_OUTCOME_LABELS[row.outcome]}</Cell>
          <Cell>{row.tickets}</Cell>
          <Cell>
            <span className="flex flex-wrap gap-2">
              {row.numbers.map((number) => (
                <Link key={number} href={`/inbox/${number}`} className={link}>
                  #{number}
                </Link>
              ))}
              {row.tickets > row.numbers.length ? (
                <span className="text-xs text-(--color-text-secondary)">
                  and {row.tickets - row.numbers.length} more
                </span>
              ) : null}
            </span>
          </Cell>
        </Row>
      ))}
    </Table>
  );
}
