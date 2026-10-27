import { UNKNOWN_CATEGORY_KEY } from '@/lib/categories/registry';

/**
 * Whether one answer from Jev may set a ticket's category
 * (`plans/ticket-category-routing.md`, decision 4).
 *
 * Pure, and where this classifier's tests live, for priority's reason: every
 * rule here is a way an automated writer of a column people also write goes
 * wrong, and each is silent once it has — a ticket refiled after a supervisor
 * chose its team looks exactly like a ticket nobody chose.
 *
 * Checked in this order:
 *
 * 1. **A person, a form or a rule always wins** (`categoryOwned`). Owned is
 *    final: nothing removes the event that made it so.
 * 2. **The first confident answer settles the ticket, and later messages
 *    leave it alone.** The category says which team's work a ticket is, and a
 *    ticket that changes teams mid-conversation is worse than one an agent
 *    relabels by hand. "First" is the earliest message by when it was written,
 *    decided under the ticket's lock, because jobs run concurrently and retry
 *    out of order — so an earlier message answered late takes the settle over
 *    from a later one, and the ticket carries what its opening said.
 * 3. **A cap per ticket**: five classified messages, and none once somebody
 *    has answered. `first_responded_at` moves for an agent and for a
 *    Business-app echo and never for an automated message, so an out-of-hours
 *    acknowledgement does not end classification before the informative second
 *    message, and a ticket that has not settled by the first human reply is a
 *    person's call.
 * 4. **`unknown` never settles anything.** It is the answer for a greeting,
 *    thanks, a lone image, anything unrelated to ShipBlu — and a greeting is
 *    the most confident answer a classifier gives, so the escape hatch must
 *    never apply or stop the ticket being asked again.
 * 5. **One threshold on the winner's share**, default 0.6. A missing
 *    probability is not a confident answer.
 *
 * The first three are known before Jev is asked, so the job checks them first
 * and records the outcome without paying for an answer (`preCallOutcome`);
 * it checks them again under the lock, because a person can answer, or another
 * message settle, while the call is out.
 */

/**
 * Who the timeline names for a change this classifier makes — priority's
 * `jev:priority` shape, so the console renders it with no new branch and the
 * ownership test can tell the classifier's own writes from everybody else's.
 */
export const CATEGORY_AI_ACTOR = 'jev:category';

/** The closed list every run row's outcome is one of. */
export const CATEGORY_OUTCOMES = [
  /** Written to the ticket. */
  'applied',
  /** Would have been written, in shadow, or in a backfill's simulation. */
  'would_apply',
  /** Jev answered `unknown`. */
  'unknown',
  /** Not confident enough to act on. */
  'below_threshold',
  /** A person, a form or a rule chose the category. */
  'owned',
  /** An earlier message already settled the ticket. */
  'after_settle',
  /** Five messages asked already, or somebody has answered the ticket. */
  'capped',
  /** No answer: the provider refused permanently, or the category was retired meanwhile. */
  'failed',
] as const;
export type CategoryOutcome = (typeof CATEGORY_OUTCOMES)[number];

/** How many messages on one ticket Jev is asked about, at most. */
export const CLASSIFIED_MESSAGE_CAP = 5;

/** Which runs mean a ticket is settled, by the mode its answers are weighed in. */
export type CategoryRunMode = 'shadow' | 'apply' | 'record';

/**
 * The outcomes that settle a ticket, by mode.
 *
 * In `apply`, only a write. In `shadow`, a write still settles — the switch
 * went back from `apply` — and so does a `would_apply`, or the shadow would
 * measure a classifier that never settles, which is not the one `apply` turns
 * on. A shadow `would_apply` does not settle once `apply` is on: nothing was
 * written, and a ticket that settled in the shadow weeks would otherwise be
 * frozen uncategorised by the switch that was meant to categorise it. A
 * backfill's `record` simulation settles on its own `would_apply`.
 */
export function settlingOutcomes(mode: CategoryRunMode): readonly CategoryOutcome[] {
  if (mode === 'apply') return ['applied'];
  if (mode === 'shadow') return ['applied', 'would_apply'];
  return ['would_apply'];
}

/** A timeline event as the ownership test reads it. */
export type CategoryEvent = { type: string; actorLabel: string | null; data: unknown };

/**
 * The half of `categoryOwned` that events decide alone: an agent opened the
 * ticket, or somebody other than Jev wrote a `category_changed`. Final once
 * true — nothing removes an event — so the live job may act on it before it
 * asks. The other half, the column against Jev's last write, is not: read in a
 * statement apart from the events, it can straddle a Jev write committing in
 * between, which would read as a column somebody else moved.
 */
export function ownedByEvent(events: readonly CategoryEvent[]): boolean {
  return events.some(
    (event) =>
      event.type === 'opened_by_agent' ||
      // An agent's event carries an agent id and no label, so `!==` rather
      // than a comparison that null would pass.
      (event.type === 'category_changed' && event.actorLabel !== CATEGORY_AI_ACTOR),
  );
}

/**
 * Whether somebody other than this classifier chose the ticket's category.
 *
 * Owned when the ticket was opened by an agent — who chose its category on
 * the New form, leaving it at none being a choice too — or when any
 * `category_changed` was written by anybody but Jev: a person in the console,
 * a rule, a form's default at creation (`form:<slug>`). And owned when the
 * column no longer holds what Jev last wrote there, or holds anything at all
 * when Jev never wrote: somebody moved it without an event, and that is theirs
 * too. Priority's test (`lib/priority-ai/run.ts`), with a category's null in
 * place of priority's `medium` default.
 *
 * Ids compare exactly: both writers store the id `holdCategory` lower-cased.
 */
export function categoryOwned(events: readonly CategoryEvent[], column: string | null): boolean {
  if (ownedByEvent(events)) return true;
  return column !== lastCategory(events);
}

/**
 * The category the last `category_changed` among `events` left, or null — what
 * the column holds when every write to it came with its event. The live job
 * compares the column with it, and a backfill judging the archive reads it as
 * the column of the moment.
 */
export function lastCategory(events: readonly CategoryEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'category_changed') continue;
    const to = (event.data as Record<string, unknown> | null)?.to;
    return typeof to === 'string' ? to : null;
  }
  return null;
}

/** Whether Jev has written the ticket's category: the live classifier, or a backfill's apply. */
export function writtenByJev(events: readonly CategoryEvent[]): boolean {
  return events.some(
    (event) => event.type === 'category_changed' && event.actorLabel === CATEGORY_AI_ACTOR,
  );
}

/**
 * The order messages are judged in: by `created_at`, then by id, since
 * WhatsApp stamps a burst to the same second and the id makes exactly one of
 * them the first. A message deleted since has no id, and on a tie of the
 * instant it is never the earlier. Negative when `a` came first. The live job
 * and the backfill both order by this, so the two agree on which message
 * settled a ticket.
 */
export function arrivedBefore(
  a: { createdAt: Date; messageId: string | null },
  b: { createdAt: Date; messageId: string },
): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  if (a.messageId === null) return 1;
  return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
}

/**
 * How long after a message the writes in the transaction that stored it can
 * be stamped. `createTicket` takes the message's time in JavaScript before its
 * transaction opens, so the agent's pick and the form's default written inside
 * it carry later instants — milliseconds later, never seconds.
 */
export const SAME_WRITE_GRACE_MS = 10_000;

/**
 * How long after a message a rule's write can land and still be one the live
 * job read. Rules run once the message's ingest has committed, and an email's
 * `created_at` is when it reached us, not when its job processed it — a queue
 * that is behind puts minutes between the two.
 */
export const RULE_PASS_GRACE_MS = 5 * 60_000;

/** A timeline event with the instant it was written. */
export type TimedCategoryEvent = CategoryEvent & { createdAt: Date };

/**
 * The events the live job would have read for a message that arrived `at`,
 * for a backfill judging the archive as of each message (`backfill.ts`).
 *
 * Not simply the events stamped by then. The live job runs after the writes
 * the message's own arrival set off — the transaction that opened the ticket,
 * the rules that ran on it — and those are stamped after the message. An
 * agent's opening and a form's default are written only when a ticket is
 * created, so they count whenever they are stamped. A rule's counts within the
 * time a rule pass can trail its message, Jev's only by then, and anything
 * else within the creation transaction's own few seconds. A person who files the ticket later — a
 * supervisor's label, the ground truth 4.2 grades against — is outside both,
 * so the message before it is still asked about.
 */
export function eventsKnownAt<E extends TimedCategoryEvent>(events: readonly E[], at: Date): E[] {
  const instant = at.getTime();
  return events.filter((event) => {
    if (event.type === 'opened_by_agent') return true;
    const label = event.actorLabel ?? '';
    if (label.startsWith('form:')) return true;
    // Jev's own write follows the job, never the message's arrival: within a
    // grace it would be the answer to this very message, read as what the
    // ticket carried before it was asked.
    if (label === CATEGORY_AI_ACTOR) return event.createdAt.getTime() <= instant;
    const grace = label.startsWith('automation:') ? RULE_PASS_GRACE_MS : SAME_WRITE_GRACE_MS;
    return event.createdAt.getTime() <= instant + grace;
  });
}

export type TicketFacts = {
  /** `categoryOwned` over the ticket's events and its column. */
  owned: boolean;
  /** A message written before this one already settled the ticket. */
  settled: boolean;
  /** Somebody answered the ticket, or five other messages were asked about. */
  capped: boolean;
};

/** The outcome known before Jev is asked, or null when it is worth asking. */
export function preCallOutcome(facts: TicketFacts): 'owned' | 'after_settle' | 'capped' | null {
  if (facts.owned) return 'owned';
  if (facts.settled) return 'after_settle';
  if (facts.capped) return 'capped';
  return null;
}

export type DecisionInput = TicketFacts & {
  mode: CategoryRunMode;
  /** The key Jev chose: a category's, or `unknown`. */
  predictedKey: string;
  /** The winner's share of the distribution; null when TypeSafe sent none. */
  probability: number | null;
  minProbability: number;
};

export function decide(input: DecisionInput): Exclude<CategoryOutcome, 'failed'> {
  const before = preCallOutcome(input);
  if (before) return before;
  if (input.predictedKey === UNKNOWN_CATEGORY_KEY) return 'unknown';
  // Reading a missing probability as 1 would let a payload that dropped a
  // field route a ticket.
  if (input.probability === null || input.probability < input.minProbability) {
    return 'below_threshold';
  }
  return input.mode === 'apply' ? 'applied' : 'would_apply';
}
