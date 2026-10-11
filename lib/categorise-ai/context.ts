import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages } from '@/db/schema';

/**
 * The earlier messages a question about one customer message carries.
 *
 * One query for both questions asked of TypeSafe — which category, and how
 * urgent — so the two are answered about the same text. A second copy that
 * drifted (a different count, notes included) would make every disagreement
 * between them partly a disagreement about what they were shown.
 */

/**
 * How many earlier messages ride along.
 *
 * Three rather than the whole thread. These messages average 22 to 39 characters,
 * so three of them is a couple of lines and costs almost nothing; the whole thread
 * would let a long ticket's opening complaint dominate the classification of a
 * later "ok thanks", which is a different message about a different thing.
 */
const CONTEXT_MESSAGES = 3;

/**
 * The inbound messages just before this one, oldest first — only `author`'s,
 * when given, since the request calls them the same customer's.
 */
export async function earlierMessages(
  conversationId: string,
  before: Date,
  author?: string | null,
): Promise<string[]> {
  const rows = await db
    .select({ bodyText: messages.bodyText })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.kind, 'reply'),
        eq(messages.direction, 'inbound'),
        sql`${messages.createdAt} < ${before.toISOString()}::timestamptz`,
        sql`btrim(${messages.bodyText}) <> ''`,
        author ? eq(messages.authorContactId, author) : undefined,
      ),
    )
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(CONTEXT_MESSAGES);

  return rows.map((row) => row.bodyText).reverse();
}
