import { NextResponse } from 'next/server';
import { extensionAgentFor } from '@/lib/auth/extension-session';
import { claimTicket } from '@/lib/extension/claim';

export const dynamic = 'force-dynamic';

/**
 * "Take this ticket" — assigns an unassigned WhatsApp ticket to the agent
 * pressing it. `lib/extension/claim.ts` says why, and what it refuses.
 *
 * 409 when somebody already holds it, carrying their name so the panel can say
 * who to ask; 403 for a missing permission; 404 for anything out of scope.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await extensionAgentFor(request);
  if (!agent) return NextResponse.json({ error: 'signed out' }, { status: 401 });

  const { id } = await context.params;
  const result = await claimTicket(agent, id);

  switch (result.kind) {
    case 'claimed':
    case 'already_yours':
      return NextResponse.json({ ok: true });
    case 'held':
      return NextResponse.json(
        {
          error: `Assigned to ${result.assigneeName}. Ask them or a supervisor to reassign it.`,
          assigneeName: result.assigneeName,
        },
        { status: 409 },
      );
    case 'refused':
      return NextResponse.json({ error: result.reason }, { status: 403 });
    case 'not_found':
      return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}
