import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { routingDecisions } from '@/db/schema';

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
): Promise<{ shadow: boolean; stage: 'pending' | 'holding' } | null> {
  const [row] = await executor
    .select({ shadow: routingDecisions.shadow, stage: routingDecisions.stage })
    .from(routingDecisions)
    .where(
      and(
        eq(routingDecisions.conversationId, conversationId),
        ne(routingDecisions.stage, 'decided'),
      ),
    );
  if (!row || row.stage === 'decided') return null;
  return { shadow: row.shadow, stage: row.stage };
}
