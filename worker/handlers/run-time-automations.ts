import { activeRules, applyRules, liveTickets } from '@/lib/automations';

/**
 * Time-based automations — Freshdesk's Supervisor. Cron, every fifteen minutes.
 *
 * These are the rules whose conditions are about elapsed time rather than about
 * something a person just did: "unassigned for four hours", "no customer reply
 * in three days, close it". Nothing else can fire them, which is why they need
 * a sweep at all.
 */

/**
 * How many tickets one run will consider.
 *
 * Oldest activity first, so the tickets a chase rule is actually about are the
 * ones inside the window. The cap exists because a rules pass over an unbounded
 * backlog is the kind of job that quietly takes an hour; when it bites, the run
 * says so rather than looking like it covered everything.
 *
 * `liveTickets` includes resolved tickets, so a large backlog of them sits at
 * the front of this ordering and can crowd out the open ones a chase rule is
 * for. It drains — the close rule takes each of them out of the population for
 * good — but if the capped-run line stays in the log for hours after a deploy,
 * that is what is happening, and the answer is a bigger cap for a few runs
 * rather than a slower schedule.
 */
const MAX_TICKETS_PER_RUN = 1000;

export async function runTimeAutomations(): Promise<void> {
  const rules = await activeRules('time_based');
  if (rules.length === 0) {
    console.log('[run_time_automations] no active rules');
    return;
  }

  const tickets = await liveTickets(MAX_TICKETS_PER_RUN);
  const now = new Date();

  let ticketsChanged = 0;
  let rulesApplied = 0;

  for (const ticket of tickets) {
    try {
      const applied = await applyRules(rules, ticket, now);
      if (applied > 0) {
        ticketsChanged += 1;
        rulesApplied += applied;
      }
    } catch (error) {
      // One ticket that cannot be processed must not stop the sweep for every
      // other ticket behind it.
      console.error(`[run_time_automations] ticket ${ticket.conversation.id} failed`, error);
    }
  }

  console.log(
    `[run_time_automations] rules=${rules.length} scanned=${tickets.length} ` +
      `tickets_changed=${ticketsChanged} rules_applied=${rulesApplied}` +
      (tickets.length === MAX_TICKETS_PER_RUN
        ? ` (capped at ${MAX_TICKETS_PER_RUN}; older tickets were not scanned this run)`
        : ''),
  );
}
