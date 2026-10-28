import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, routingDecisions } from '@/db/schema';
import { logger } from '@/lib/log';
import { routeNow } from './apply';

const log = logger('routing');

/**
 * The creation pass's routing step, between the first SLA selection and
 * assignment (`afterInboundMessage`). What it answers decides whether the pass
 * carries on: `routed` means the router has taken the ticket — decided it, or
 * is deciding it — and assigns it and sends its held reply itself.
 *
 * After the `on_create` rules, so a rule always gets the first word: a rule's
 * `assign_agent` or `assign_group` has ended the hold already (`endHold`), and
 * a rule's `set_category` is a settled category this routes on now. After the
 * first SLA selection too, which the plan placed after this step: that order
 * routed a ticket an `on_create` rule had filed without ever choosing it a
 * policy when the decision moved nothing (`no_route_for_category`), and when
 * it moved the ticket chose its first policy through a re-selection whose
 * `sla_recalculated` described a change nothing made. Here the ticket has its
 * clocks, and the router's re-selection is the ordinary one.
 *
 * Nearly every ticket never routed, so the undecided routing row is looked for
 * first, with no transaction and no lock, and a ticket without one carries on
 * at once. Then, under the row lock, one of three things:
 *
 * - **Nothing to do** — a row a rule or a person decided since that look. The
 *   pass carries on as it would without routing.
 * - **A category is settled** — by a rule, or by Jev answering before the pass
 *   got here, which wrote only the category and left the rest to this. A live
 *   ticket is routed now (`routeNow`); a shadow one has its would-be decision
 *   recorded and the pass carries on.
 * - **Otherwise the row moves to `holding`**, so Jev's answer, when it comes,
 *   routes the ticket itself; and the pass carries on into assignment and the
 *   reply, which the hold skips.
 *
 * Best-effort, like every lifecycle step: a throw is logged and answers
 * `continue`, the hold stays, and `settle_routing` decides at the window's
 * end, treating `pending` as `holding`.
 */
export async function beginRouting(
  conversationId: string,
  now: Date = new Date(),
): Promise<'routed' | 'continue'> {
  try {
    // Unlocked, as `endHold` reads it, and for the same reason an answer of
    // none cannot go stale: the row is born in the ticket's own insert
    // transaction, committed before the creation pass runs, and once decided
    // is never undecided again. With the lock taken first, every new ticket
    // on every channel paid a transaction, and every other writer of it a
    // wait behind that, to learn that nothing routes.
    const [undecided] = await db
      .select({ id: routingDecisions.id })
      .from(routingDecisions)
      .where(
        and(
          eq(routingDecisions.conversationId, conversationId),
          ne(routingDecisions.stage, 'decided'),
        ),
      );
    if (!undecided) return 'continue';

    const found = await db.transaction(async (tx) => {
      // The ticket first, then its routing row, as every routing writer takes
      // them, and the row read again under them: a rule or a person may have
      // decided it since the look above. NO KEY UPDATE: it serialises against
      // every other writer just the same, where FOR UPDATE would also stop the
      // customer's next message — whose foreign key takes KEY SHARE on the
      // ticket — until this commits (`lib/routing/apply.ts`).
      const [ticket] = await tx
        .select({ categoryId: conversations.categoryId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .for('no key update');
      if (!ticket) return null;

      const [row] = await tx
        .select({
          id: routingDecisions.id,
          shadow: routingDecisions.shadow,
          stage: routingDecisions.stage,
          phaseOneAt: routingDecisions.phaseOneAt,
        })
        .from(routingDecisions)
        .where(eq(routingDecisions.conversationId, conversationId))
        .for('update');
      if (!row || row.stage === 'decided') return null;

      // A person's category edit got here first and is routing the ticket.
      if (row.phaseOneAt) return { shadow: row.shadow, settled: true, inFlight: true };

      if (!ticket.categoryId && row.stage === 'pending') {
        await tx
          .update(routingDecisions)
          .set({ stage: 'holding' })
          .where(eq(routingDecisions.id, row.id));
      }
      return { shadow: row.shadow, settled: ticket.categoryId !== null, inFlight: false };
    });

    if (!found || !found.settled) return 'continue';
    if (found.inFlight) return found.shadow ? 'continue' : 'routed';

    const result = await routeNow(conversationId, { label: BEGIN_ACTOR }, now);
    if (found.shadow) return 'continue';
    return result === 'decided' || result === 'in_flight' ? 'routed' : 'continue';
  } catch (error) {
    log.error(`could not begin routing ${conversationId}`, error);
    return 'continue';
  }
}

/** The label of a decision the creation pass made on a category already settled. */
const BEGIN_ACTOR = 'creation';
