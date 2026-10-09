'use server';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversationShipments, shipments } from '@/db/schema';
import { requireAgent } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { can } from '@/lib/auth/permissions';
import {
  attachShipment,
  attachShippingAccount,
  detachShipment,
  detachShippingAccount,
  upsertShipmentStub,
  upsertShippingAccountStub,
} from '@/lib/shipments/links';
import { normaliseSbid, normaliseTrackingNumber } from '@/lib/shipments/format';
import { syncShipment } from '@/lib/shipments/sync';
import { loadConversation, refresh } from '@/lib/tickets/console-guards';
import type { ActionState } from './action-state';

// --- Shipments --------------------------------------------------------------

/**
 * Attaching a parcel to a ticket by hand.
 *
 * Deliberately does *not* check the value against the detection pattern. An
 * agent reading a number off a label or out of the shipping platform is more
 * authoritative than our guess at the format — and the whole reason the pattern
 * is configurable is that the guess is known to be incomplete. Refusing what an
 * agent typed because a regular expression disagreed would be the tail wagging
 * the dog.
 */
export async function linkShipment(_state: ActionState, formData: FormData): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.edit_fields')) {
    return { error: 'You do not have permission to change this ticket' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const trackingNumber = normaliseTrackingNumber(String(formData.get('trackingNumber') ?? ''));
  if (!trackingNumber) return { error: 'Enter a tracking number' };

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const shipmentId = await upsertShipmentStub(trackingNumber);
  const created = await attachShipment({
    conversationId,
    shipmentId,
    linkSource: 'manual',
    linkedByAgentId: agent.id,
  });

  if (created) {
    await db.insert(conversationEvents).values({
      conversationId,
      type: 'shipment_linked',
      actorAgentId: agent.id,
      data: { trackingNumber, shipmentId },
    });
  }

  refresh(row.conversation.number);
  return ok();
}

export async function unlinkShipment(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.edit_fields')) {
    return { error: 'You do not have permission to change this ticket' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const shipmentId = String(formData.get('shipmentId') ?? '');
  const trackingNumber = String(formData.get('trackingNumber') ?? '');

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  await detachShipment(conversationId, shipmentId);

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'shipment_unlinked',
    actorAgentId: agent.id,
    data: { trackingNumber, shipmentId },
  });

  refresh(row.conversation.number);
  return ok();
}

/**
 * Fetching one parcel's latest state, while an agent watches.
 *
 * This calls the platform **in the action** rather than queueing a job, and it
 * is the second control in this codebase to do so — `refreshRequesterProfile` is
 * the first, and AGENTS.md writes the exception down precisely so this case can
 * be recognised rather than argued each time. The whole output of the button is
 * the provider's answer: an agent has a customer on the line asking where a
 * parcel is, and queueing the lookup would put the one sentence they are waiting
 * for into a worker log they cannot read.
 *
 * The provider call itself stays in `syncShipment`, shared with the
 * `sync_shipment` job, so the button and the queue cannot answer differently
 * about the same parcel. That is the other half of the rule and the half that
 * matters: the exception is about *who waits*, never about having two paths.
 *
 * `force`, because that is the point of pressing it. Without it a parcel synced
 * four minutes ago returns "synced recently" and the agent has no way to insist.
 *
 * No timeline event is written. `refreshRequesterProfile` records one because it
 * stamps an identity onto a contact — a durable claim somebody should be able to
 * audit. This writes a cache of a public fact that anyone holding the tracking
 * number can read, it is idempotent, and it is pressed repeatedly by design; an
 * entry per press would bury the ticket's actual history.
 */
export async function refreshShipment(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.view')) {
    return { error: 'You do not have permission to look up shipments' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const shipmentId = String(formData.get('shipmentId') ?? '');

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  /*
   * The link is re-read rather than trusted, which is the house rule for any id
   * arriving in a `FormData` field and is load-bearing here: without it the
   * field is an argument to an outbound request, and any signed-in agent could
   * use this ticket as a lever to sync — and so cache into our database — a
   * parcel their permissions never let them see.
   */
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

  if (!linked[0]) return { error: 'That shipment is not linked to this ticket' };

  const result = await syncShipment({ shipmentId, force: true });

  switch (result.kind) {
    case 'synced':
      refresh(row.conversation.number);
      return ok();
    case 'not_found':
      // Recorded on the row by the sync, so the sidebar now says so itself.
      refresh(row.conversation.number);
      return { error: 'The shipping platform does not recognise this number' };
    case 'gone':
      return { error: 'That shipment no longer exists' };
    case 'transient':
      return { error: 'The shipping platform could not be reached. Try again in a moment.' };
    case 'refused':
      return { error: `The shipping platform refused the lookup: ${result.error.message}` };
    case 'skipped':
      // Unreachable with `force`, and enumerated so a new result kind is a type
      // error here rather than a silent success in front of an agent. Revalidated
      // all the same, as every success is (`action-revalidates`).
      refresh(row.conversation.number);
      return ok();
  }
}

export async function linkShippingAccount(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.edit_fields')) {
    return { error: 'You do not have permission to change this ticket' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const sbid = normaliseSbid(String(formData.get('sbid') ?? ''));
  if (!sbid) return { error: 'Enter an SBID' };

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  const shippingAccountId = await upsertShippingAccountStub(sbid);
  const created = await attachShippingAccount({
    conversationId,
    shippingAccountId,
    linkSource: 'manual',
    linkedByAgentId: agent.id,
  });

  if (created) {
    await db.insert(conversationEvents).values({
      conversationId,
      type: 'shipping_account_linked',
      actorAgentId: agent.id,
      data: { sbid, shippingAccountId },
    });
  }

  refresh(row.conversation.number);
  return ok();
}

export async function unlinkShippingAccount(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'ticket.edit_fields')) {
    return { error: 'You do not have permission to change this ticket' };
  }

  const conversationId = String(formData.get('conversationId') ?? '');
  const shippingAccountId = String(formData.get('shippingAccountId') ?? '');
  const sbid = String(formData.get('sbid') ?? '');

  const row = await loadConversation(agent, conversationId);
  if (!row) return { error: 'Ticket not found' };

  await detachShippingAccount(conversationId, shippingAccountId);

  await db.insert(conversationEvents).values({
    conversationId,
    type: 'shipping_account_unlinked',
    actorAgentId: agent.id,
    data: { sbid, shippingAccountId },
  });

  refresh(row.conversation.number);
  return ok();
}
