import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { routingDecisions } from '@/db/schema';
import type { RoutingOutcome } from './decide';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Where an undecided ticket's routing stands, as `undecidedRouting` answers it. */
export type UndecidedRouting = {
  shadow: boolean;
  stage: 'pending' | 'holding';
  /**
   * Whether phase one has already written the router's decision, which some
   * caller is finishing (`lib/routing/apply.ts`). That decision read the
   * ticket before whatever the caller is about to do to it: a category the
   * caller then writes is one the router never decided on, and its pass over
   * the rules is not the router's to run (`routerDecidedOn`).
   */
  phaseOneWritten: boolean;
};

/**
 * Where a ticket's routing stands, while it is undecided: null for a ticket
 * that never entered routing and for one already decided, which every caller
 * treats alike — as a ticket routing has nothing more to say about.
 *
 * Read inside the caller's transaction when the answer decides what it does
 * next — the classifier, under the row lock its write took — because the
 * stage moves under that lock (`beginRouting`, `routeNow`), and read after the
 * commit it can already have moved.
 */
export async function undecidedRouting(
  executor: Executor,
  conversationId: string,
): Promise<UndecidedRouting | null> {
  const [row] = await executor
    .select({
      shadow: routingDecisions.shadow,
      stage: routingDecisions.stage,
      phaseOneAt: routingDecisions.phaseOneAt,
    })
    .from(routingDecisions)
    .where(
      and(
        eq(routingDecisions.conversationId, conversationId),
        ne(routingDecisions.stage, 'decided'),
      ),
    );
  if (!row) return null;
  // The WHERE has left `decided` out, so the row is one of the other two; the
  // column's type still carries all three, and the answer names only these.
  return {
    shadow: row.shadow,
    stage: row.stage === 'pending' ? 'pending' : 'holding',
    phaseOneWritten: row.phaseOneAt !== null,
  };
}

/**
 * The outcomes that are not the router's: `endHold`'s two, written by a person
 * or a rule deciding without looking at the category at all, and `not_open`,
 * where the router found the ticket in nobody's queue and ran no pass.
 */
const NOT_THE_ROUTERS_PASS: ReadonlySet<RoutingOutcome> = new Set(['manual', 'rule', 'not_open']);

/**
 * Whether the router's pass over the `on_update` rules covers a category
 * written on a held ticket — asked by the category's writer, the console's
 * edit or Jev's answer, once `routeNow` has answered `none` or `in_flight`:
 * somebody decided between the write's commit and the router's lock, or is
 * part-way through deciding. True, and the writer runs no pass of its own,
 * which would be a second: every rule keyed on the category fires twice, a
 * canned reply sent twice, a note written twice. False, and the pass is the
 * writer's, which on a ticket still held assigns nobody, and in which a rule's
 * move ends nothing.
 *
 * `written` is what the writer knows from under its own lock: the category it
 * wrote, and whether phase one had been written by then
 * (`UndecidedRouting.phaseOneWritten`).
 *
 * - **Not the router's decision** — `manual` or `rule`, or `not_open`: false.
 *   `endHold` decides without reading the category, and `not_open` ran no
 *   pass; a router owing nothing is not the edit's pass having run, and a
 *   person's edit on a ticket resolved in its window meets its rules as an
 *   edit on any resolved ticket does.
 * - **A phase one written after the write** — it read the ticket under the
 *   lock after the write committed: this category, whose pass the router runs,
 *   or a later writer's, whose pass the router runs instead. True either way.
 *   A pass here would run on whatever the ticket carries now, so after a later
 *   writer it is that writer's category a second time, not this one's a first.
 * - **A phase one written before the write** — it decided on the category this
 *   write replaced, and its pass ran on that one, or gives up on finding the
 *   ticket carrying another (`finish`): true only when it is this very
 *   category, which a write that changed the column cannot be but for a third
 *   writer putting the old one back in between.
 */
export async function routerDecidedOn(
  conversationId: string,
  written: { categoryId: string; phaseOneWritten: boolean },
): Promise<boolean> {
  const [row] = await db
    .select({ outcome: routingDecisions.outcome, categoryId: routingDecisions.categoryId })
    .from(routingDecisions)
    .where(eq(routingDecisions.conversationId, conversationId));
  if (!row?.outcome || NOT_THE_ROUTERS_PASS.has(row.outcome)) return false;
  if (!written.phaseOneWritten) return true;
  return row.categoryId === written.categoryId;
}
