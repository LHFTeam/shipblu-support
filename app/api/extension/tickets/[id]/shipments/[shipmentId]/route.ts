import { NextResponse } from 'next/server';
import { extensionAgentFor } from '@/lib/auth/extension-session';
import { ticketShipmentDetail } from '@/lib/extension/tickets';

export const dynamic = 'force-dynamic';

/** One parcel's tracking — its events, the address and the COD amount. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; shipmentId: string }> },
) {
  const agent = await extensionAgentFor(request);
  if (!agent) return NextResponse.json({ error: 'signed out' }, { status: 401 });

  const { id, shipmentId } = await context.params;
  const detail = await ticketShipmentDetail(agent, id, shipmentId);
  if (detail === 'forbidden') {
    return NextResponse.json(
      { error: 'You do not have permission to see shipment details' },
      { status: 403 },
    );
  }
  if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json(detail);
}
