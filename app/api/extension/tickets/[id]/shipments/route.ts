import { NextResponse } from 'next/server';
import { extensionAgentFor } from '@/lib/auth/extension-session';
import { ticketShipments } from '@/lib/extension/tickets';

export const dynamic = 'force-dynamic';

/** The parcels on a ticket, for the extension's Shipments tab. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const agent = await extensionAgentFor(request);
  if (!agent) return NextResponse.json({ error: 'signed out' }, { status: 401 });

  const { id } = await context.params;
  const shipments = await ticketShipments(agent, id);
  if (!shipments) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json({ shipments });
}
