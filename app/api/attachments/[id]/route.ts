import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { attachments, conversations, messages } from '@/db/schema';
import { can } from '@/lib/auth/permissions';
import { getSessionAgent } from '@/lib/auth/session';
import { signedUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Redirects to a short-lived signed URL for one attachment.
 *
 * The bucket is private and stays that way: a ticket attachment can be an
 * invoice, an ID document or a delivery address. Serving through this route
 * means every download is behind the session check *and* the agent's ticket
 * visibility, and the URL that reaches the browser expires in five minutes.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await getSessionAgent();
  if (!agent) return NextResponse.json({ error: 'unauthorised' }, { status: 401 });

  const { id } = await context.params;

  const rows = await db
    .select({
      storagePath: attachments.storagePath,
      assigneeAgentId: conversations.assigneeAgentId,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(attachments.id, id))
    .limit(1);

  const attachment = rows[0];
  if (!attachment) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Same visibility rule as the ticket the file hangs off — otherwise an
  // attachment id would be a way around it.
  if (!can(agent, 'ticket.view.all') && attachment.assigneeAgentId !== agent.id) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const url = await signedUrl(attachment.storagePath, 300);
  return NextResponse.redirect(url, { status: 307 });
}
