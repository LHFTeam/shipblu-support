import { and, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agentPresenceIntervals, agents } from '@/db/schema';
import { enqueue } from '@/lib/queue';
import { HEARTBEAT_TTL_MS } from './eligibility';

/** Who turned the switch off — `null` is only ever "they are accepting". */
export type AvailabilityReason = 'self' | 'idle' | 'supervisor';

/**
 * Whether an agent is at their desk.
 *
 * The signal is the console's lightweight presence stream: it is open while
 * somebody has any signed-in console page in front of them and closed when they
 * do not. No "set yourself to available" ritual to forget — the connection that
 * already proves presence is used to record it. Conversation invalidations have
 * their own inbox-only stream, so ticket traffic cannot make presence expensive.
 *
 * `agents.presence` has exactly one writer, this module, called from exactly one
 * place. The agent's own away switch is a different column
 * (`is_accepting_tickets`) precisely so it is not a second writer here: a manual
 * "away" that the next reconnect silently overwrites is worse than no switch.
 *
 * **Multiple streams are handled by expiry rather than by counting.** An agent
 * with two tabs who closes one is marked offline, and the surviving tab's next
 * beat — at most 25 seconds later — puts them back. Reference counting would
 * need state shared across autoscaled instances to be correct, and being briefly
 * skipped by the rota is a far cheaper error than being permanently online
 * because a counter leaked.
 *
 * **This module also keeps the history.** `agent_presence_intervals` is the
 * record `agents.presence` structurally cannot be — a column knows only what is
 * true now — and it is written here, from the same three functions, so presence
 * still has exactly one writer.
 *
 * The writes are deliberately best-effort and approximate: they extend an open
 * interval when they can and open a new one when they cannot, and they make no
 * attempt to be transactionally exact about it. Two instances racing can leave
 * two overlapping open rows, and the flapping described above can leave a
 * shift in several pieces. Neither is corrected here, because both are
 * correctable at *read* time and only at read time: `lib/reports/intervals.ts`
 * merges overlapping and near-adjacent spans before measuring anything. Pushing
 * that correctness into the write path would need locking on the hottest write
 * in the system to buy nothing the reader cannot do with a sort.
 */

/**
 * A stream opened. Also drains the queue: somebody just arrived for their shift.
 *
 * The sweep is asked for only on a real offline→online transition. A reload
 * reopens the stream and would otherwise ask on every navigation.
 */
export async function goOnline(agentId: string): Promise<void> {
  const arrived = await db
    .update(agents)
    .set({ presence: 'online', lastSeenAt: new Date() })
    .where(and(eq(agents.id, agentId), ne(agents.presence, 'online')))
    .returning({ id: agents.id, accepting: agents.isAcceptingTickets });

  if (arrived.length === 0) {
    // Already online — a second tab, or a reload. Just move the heartbeat.
    await beat(agentId);
    return;
  }

  await record(agentId, arrived[0]!.accepting);
  await requestSweep();
}

/** A keepalive fired. Re-asserts `online` so a sibling tab closing cannot strand it. */
export async function beat(agentId: string): Promise<void> {
  const beaten = await db
    .update(agents)
    .set({ presence: 'online', lastSeenAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning({ accepting: agents.isAcceptingTickets });

  if (beaten.length > 0) await record(agentId, beaten[0]!.accepting);
}

export async function goOffline(agentId: string): Promise<void> {
  await db.update(agents).set({ presence: 'offline' }).where(eq(agents.id, agentId));
  await close(agentId, new Date());
}

/**
 * The away switch, and the record of it.
 *
 * Here rather than in the server action because the switch marks the boundary
 * between available and merely present, and that boundary is a span of time —
 * the same shape as being connected. Closing the interval and opening a
 * replacement makes "available time" a sum over rows instead of a replay of two
 * interleaved event streams.
 *
 * Three callers now, which is why `reason` is not optional at the call site's
 * discretion: the agent's own switch, a supervisor's, and the idle sweep. Only
 * the last of the three may be undone automatically, and the column is how
 * anything downstream can tell — see `availabilityReasonEnum`. A caller that
 * could leave it unset would eventually park somebody with no way to know
 * whether returning to their desk should bring them back.
 *
 * A call that changes nothing writes nothing. `acceptingChangedAt` is the grace
 * period the sweep measures against, so re-asserting the current state — which
 * a double-click or two supervisors reaching for the same row will do — must
 * not silently extend it.
 *
 * The interval boundary is only recorded for an agent who is actually
 * connected. Flipping the switch from a page load after the stream has gone
 * would otherwise open an interval that says they were at their desk because
 * they changed a setting.
 */
export async function setAccepting(
  agentId: string,
  accepting: boolean,
  reason: AvailabilityReason,
): Promise<boolean> {
  const nextReason = accepting ? null : reason;

  // Read then write, rather than one conditional UPDATE. The condition is "the
  // flag or the reason differs", and the reason is an enum: expressing that in
  // a single statement means a raw fragment comparing an enum column to a bound
  // string, which is the shape that type-checks, passes every test — Vitest
  // runs without a database — and then fails in production with `operator does
  // not exist` (docs/PROJECT-STATE.md §6.46). Two round trips on an action
  // somebody clicks a few times a day is the cheaper side of that trade.
  const before = await db
    .select({
      accepting: agents.isAcceptingTickets,
      reason: agents.acceptingOffReason,
      presence: agents.presence,
      lastSeenAt: agents.lastSeenAt,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  const agent = before[0];
  if (!agent) return false;
  if (agent.accepting === accepting && agent.reason === nextReason) return false;

  const now = new Date();

  await db
    .update(agents)
    .set({
      isAcceptingTickets: accepting,
      acceptingOffReason: nextReason,
      // When the switch moved, and only then. A new reason on an agent who was
      // already away — a supervisor taking over an idle park — is not the
      // switch moving: the reclaim wait measures how long they have been
      // unavailable, and restarting it here would push every such ticket back.
      // The idle grace reads the column only while an agent is accepting, so
      // it never sees the difference.
      ...(agent.accepting !== accepting && { acceptingChangedAt: now }),
      updatedAt: now,
    })
    .where(eq(agents.id, agentId));

  const live =
    agent.presence === 'online' &&
    agent.lastSeenAt !== null &&
    now.getTime() - agent.lastSeenAt.getTime() < HEARTBEAT_TTL_MS;

  if (live) {
    await close(agentId, now);
    await open(agentId, accepting, now);
  }

  return true;
}

// --- The history ------------------------------------------------------------

/**
 * Extend the agent's live interval, or start one.
 *
 * "Live" means open, carrying the same accepting flag, and beaten within the
 * heartbeat TTL — the same window assignment already uses to decide somebody has
 * gone, so the two cannot disagree about when a shift ended.
 *
 * Failures are swallowed. This is a record for a report that is read tomorrow;
 * it must never be the reason an agent loses their live updates, which is the
 * same trade the caller in `/api/presence` already makes for presence itself.
 */
async function record(agentId: string, accepting: boolean): Promise<void> {
  const now = new Date();

  try {
    const extended = await db
      .update(agentPresenceIntervals)
      .set({ lastBeatAt: now })
      .where(
        and(
          eq(agentPresenceIntervals.agentId, agentId),
          isNull(agentPresenceIntervals.endedAt),
          eq(agentPresenceIntervals.accepting, accepting),
          gte(agentPresenceIntervals.lastBeatAt, new Date(now.getTime() - HEARTBEAT_TTL_MS)),
        ),
      )
      .returning({ id: agentPresenceIntervals.id });

    if (extended.length > 0) return;

    // Nothing live to extend. Anything still open is stale — an instance that
    // died without running its abort handler — and its last beat is the honest
    // end, so seal it at that rather than at now and leave a gap that never
    // happened.
    await db
      .update(agentPresenceIntervals)
      .set({ endedAt: sql`${agentPresenceIntervals.lastBeatAt}` })
      .where(
        and(
          eq(agentPresenceIntervals.agentId, agentId),
          isNull(agentPresenceIntervals.endedAt),
          lt(agentPresenceIntervals.lastBeatAt, new Date(now.getTime() - HEARTBEAT_TTL_MS)),
        ),
      );

    await open(agentId, accepting, now);
  } catch (error) {
    console.error('[presence] could not record an interval', error);
  }
}

async function open(agentId: string, accepting: boolean, at: Date): Promise<void> {
  try {
    await db
      .insert(agentPresenceIntervals)
      .values({ agentId, accepting, startedAt: at, lastBeatAt: at });
  } catch (error) {
    console.error('[presence] could not open an interval', error);
  }
}

/** A clean sign-off. Anything still open for this agent ends now. */
async function close(agentId: string, at: Date): Promise<void> {
  try {
    await db
      .update(agentPresenceIntervals)
      .set({ endedAt: at })
      .where(
        and(eq(agentPresenceIntervals.agentId, agentId), isNull(agentPresenceIntervals.endedAt)),
      );
  } catch (error) {
    console.error('[presence] could not close an interval', error);
  }
}

/**
 * Ask the sweep to look at the unassigned queue now.
 *
 * Without this, a ticket that arrived overnight waits for the next five-minute
 * cron tick after the first agent signs in. With it, the queue drains as the
 * shift starts.
 *
 * The dedupe key carries the current minute, which collapses a whole team
 * arriving at nine o'clock into one job — the sweep considers every unassigned
 * ticket anyway, so thirty of them would do the same work thirty times. It must
 * *not* be a constant: `jobs_dedupe_idx` is unique across every row whatever its
 * status, and completed jobs are kept for seven days, so a fixed key would
 * enqueue once and then silently collapse into a finished row for a week.
 */
async function requestSweep(): Promise<void> {
  const minute = new Date().toISOString().slice(0, 16);

  try {
    await enqueue('assign_sweep', {}, { dedupeKey: `assign_sweep:${minute}`, priority: 50 });
  } catch (error) {
    // Presence is worth recording even when the queue is unreachable; the cron
    // will pick the tickets up on its own schedule.
    console.error('[presence] could not enqueue assign_sweep', error);
  }
}

export { requestSweep as requestAssignmentSweep };
