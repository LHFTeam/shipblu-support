import { NextResponse } from 'next/server';
import { extensionAgentFor } from '@/lib/auth/extension-session';
import { sideConversationRecipients } from '@/lib/extension/tickets';

export const dynamic = 'force-dynamic';

/** The hubs, teams and vendors the composer's picker offers. */
export async function GET(request: Request) {
  const agent = await extensionAgentFor(request);
  if (!agent) return NextResponse.json({ error: 'signed out' }, { status: 401 });

  return NextResponse.json({ recipients: await sideConversationRecipients(agent) });
}
