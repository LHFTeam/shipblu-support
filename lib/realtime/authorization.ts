import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations } from '@/db/schema';
import type { SessionAgent } from '@/lib/auth/session';
import { conversationVisibility } from '@/lib/tickets/queries';

/**
 * Re-checks a requested conversation before opening its dedicated LISTEN topic.
 *
 * The UUID came from a query string even when the normal caller obtained it
 * from a server-rendered ticket. Treating that as proof would turn a guessed id
 * into a notification oracle. The same SQL visibility clauses as every other
 * read keep a hidden or unassigned ticket indistinguishable from a missing one.
 */
export async function canSubscribeToConversation(
  agent: SessionAgent,
  conversationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), ...conversationVisibility(agent)))
    .limit(1);

  return rows.length > 0;
}
