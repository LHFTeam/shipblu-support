import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  attachments,
  conversations,
  messages,
  sideConversationMessages,
  sideConversations,
} from '@/db/schema';
import { can } from '@/lib/auth/permissions';
import { getSessionAgent } from '@/lib/auth/session';
import { ATTACHMENT_URL_TTL_SECONDS } from '@/lib/attachments/signed-url';
import { isUuid } from '@/lib/http/uuid';
import { canSeeChannel } from '@/lib/tickets/channel-policy';
import { signedUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Redirects to a short-lived signed URL for one attachment.
 *
 * The bucket is private and stays that way: a ticket attachment can be an
 * invoice, an ID document or a delivery address. Serving through this route
 * means every download is behind the session check *and* the agent's ticket
 * visibility, and the URL that reaches the browser expires in five minutes.
 *
 * A file can hang off a ticket message or off a side conversation message — the
 * photograph a hub sends back of a failed delivery is the common case for the
 * second. Both resolve to the same ticket and are authorised against it: a side
 * conversation has no visibility rule of its own, it is exactly as reachable as
 * the ticket it belongs to.
 *
 * `COALESCE` over a single left-joined query rather than two round trips, so the
 * two paths cannot answer differently.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await getSessionAgent();
  if (!agent) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const { id } = await context.params;
  // A malformed id is a link to nothing, not a server fault — Postgres would
  // answer it with 22P02, which this route used to pass on as a 500.
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const rows = await db
    .select({
      storagePath: attachments.storagePath,
      assigneeAgentId: conversations.assigneeAgentId,
      channel: conversations.channel,
    })
    .from(attachments)
    .leftJoin(messages, eq(messages.id, attachments.messageId))
    .leftJoin(sideConversationMessages, eq(sideConversationMessages.id, attachments.sideMessageId))
    .leftJoin(
      sideConversations,
      eq(sideConversations.id, sideConversationMessages.sideConversationId),
    )
    .innerJoin(
      conversations,
      eq(
        conversations.id,
        sql`COALESCE(${messages.conversationId}, ${sideConversations.conversationId})`,
      ),
    )
    .where(eq(attachments.id, id))
    .limit(1);

  const attachment = rows[0];
  if (!attachment) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Same visibility rule as the ticket the file hangs off — otherwise an
  // attachment id would be a way around it.
  if (!can(agent, 'ticket.view.all') && attachment.assigneeAgentId !== agent.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // And the channel rule, which this route had no reason to check while every
  // attachment came from email: a bot transcript's media is on a channel an
  // agent without `ticket.view.bot` may not open at all.
  if (!canSeeChannel(agent, attachment.channel)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const url = await signedUrl(attachment.storagePath, ATTACHMENT_URL_TTL_SECONDS);
  const response = NextResponse.redirect(url, { status: 307 });
  // A redirect carrying no freshness is not cached heuristically, but this one
  // names a URL that stops working within minutes and an inline player asks
  // for it again on purpose to get a new one, so it says so rather than relying
  // on that. And a 307 rather than a 308: a permanent redirect may be cached.
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
