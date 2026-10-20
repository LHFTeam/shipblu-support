import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationShipments, shipments } from '@/db/schema';
import { can } from '@/lib/auth/permissions';
import type { SessionAgent } from '@/lib/auth/session';
import { isUuid } from '@/lib/http/uuid';
import { shipmentCard } from '@/lib/shipments/card';
import { agentTrackingFor } from '@/lib/shipments/lookup';
import { trackingView } from '@/lib/shipments/tracking-view';
import { shipmentsForConversation } from '@/lib/shipments/queries';
import { describeRequesterRole } from '@/lib/shipments/roles';
import {
  listSideConversationRecipients,
  sideConversationsForConversation,
} from '@/lib/side-conversations/queries';
import { loadConversation } from '@/lib/tickets/console-guards';

/**
 * What the WhatsApp Web extension's side panel reads about a ticket.
 *
 * Every function starts at `loadConversation`, the console's own visibility
 * rule, and answers null for a ticket the agent may not see — the route turns
 * that into a 404, so a ticket outside the agent's view and one that does not
 * exist look the same from outside. Nothing here reads a table the console's
 * ticket page does not already read for the same agent.
 */

/**
 * The parcels on a ticket, with the words and tone the console's sidebar draws.
 *
 * The card is computed here rather than in the extension because the rule it
 * encodes has already been wrong in production: a return outranks the status
 * label, which stays `delivery_attempted` for the whole of one (§6.40). A
 * second copy in the extension's script would be the place that rule drifts.
 */
export async function ticketShipments(agent: SessionAgent, conversationId: string) {
  const row = await loadConversation(agent, conversationId);
  if (!row) return null;

  const linked = await shipmentsForConversation(
    row.conversation.id,
    row.conversation.requesterContactId,
  );

  return linked.map((shipment) => ({
    shipmentId: shipment.shipmentId,
    trackingNumber: shipment.trackingNumber,
    card: shipmentCard(shipment),
    // A status we have not synced is no statement about when it changed.
    statusAt: shipment.syncState === 'synced' ? shipment.statusAt : null,
    lastSyncedAt: shipment.lastSyncedAt,
    returning: shipment.returnStep !== null,
    sbid: shipment.sbid,
    requesterRole: describeRequesterRole(shipment.requesterRole),
    linkSource: shipment.linkSource,
  }));
}

/**
 * One parcel's full tracking, as the console's shipment page shows it, and
 * the `trackingView` that page words it with.
 *
 * Behind `contact.view`, as that page is: it carries the recipient's name,
 * address, phone and the COD amount. And only for a parcel linked to this
 * ticket, so the route cannot be used to read any tracking number by guessing
 * shipment ids — the ticket the agent may see is what admits the parcel.
 *
 * Answers `forbidden` apart from null so the panel can say why the detail is
 * missing rather than showing a parcel that seems not to exist.
 */
export async function ticketShipmentDetail(
  agent: SessionAgent,
  conversationId: string,
  shipmentId: string,
) {
  if (!can(agent, 'contact.view')) return 'forbidden' as const;
  if (!isUuid(shipmentId)) return null;

  const row = await loadConversation(agent, conversationId);
  if (!row) return null;

  const linked = await db
    .select({ trackingNumber: shipments.trackingNumber })
    .from(conversationShipments)
    .innerJoin(shipments, eq(shipments.id, conversationShipments.shipmentId))
    .where(
      and(
        eq(conversationShipments.conversationId, row.conversation.id),
        eq(conversationShipments.shipmentId, shipmentId),
      ),
    )
    .limit(1);

  const trackingNumber = linked[0]?.trackingNumber;
  const tracking = trackingNumber ? await agentTrackingFor(trackingNumber) : null;
  // With the words the console's shipment page draws, from the same function,
  // so a return reads the same in the panel as it does there.
  return tracking ? { tracking, view: trackingView(tracking) } : null;
}

/**
 * The ticket's side conversations, and whether this agent may write in them.
 *
 * A side conversation is as visible as its ticket, no more and no less (see
 * `lib/side-conversations/queries.ts`), so reading needs only the ticket;
 * writing needs `ticket.side_conversation`, and the panel hides the composer
 * without it rather than offering one every send of which is refused.
 */
export async function ticketSideConversations(agent: SessionAgent, conversationId: string) {
  const row = await loadConversation(agent, conversationId);
  if (!row) return null;

  return {
    canWrite: can(agent, 'ticket.side_conversation'),
    sideConversations: await sideConversationsForConversation(row.conversation.id),
  };
}

/**
 * The directory the composer's picker offers. Empty without the permission to
 * write, as the console's ticket page loads it.
 */
export async function sideConversationRecipients(agent: SessionAgent) {
  return can(agent, 'ticket.side_conversation') ? listSideConversationRecipients() : [];
}
