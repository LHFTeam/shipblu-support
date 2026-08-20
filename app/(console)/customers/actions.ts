'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, shipments } from '@/db/schema';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { normaliseSbid, normaliseTrackingNumber } from '@/lib/shipments/format';
import {
  addContactToShippingAccount,
  refreshContactRoles,
  removeContactFromShippingAccount,
  upsertShippingAccountStub,
} from '@/lib/shipments/links';

/**
 * Writes from the customer, account and shipment pages.
 *
 * Same shape as the ticket actions: authorise, write, revalidate. There is no
 * `conversation_events` row to write here — these are facts about a person or a
 * parcel rather than about one ticket, and inventing a per-ticket audit entry
 * for them would put the change on whichever ticket happened to be open.
 */

export type CustomerActionState = { error: string | null; ok?: boolean; nonce?: number };

function ok(): CustomerActionState {
  return { error: null, ok: true, nonce: Date.now() };
}

/**
 * Says that a person can speak for a shipping account.
 *
 * This is the one place a membership is ever asserted. The detector will not do
 * it, however many times somebody types their SBID into a chat, because quoting
 * an account number proves the number came up — not that it is yours.
 */
export async function linkContactToAccount(
  _state: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.edit')) {
    return { error: 'You do not have permission to edit customers' };
  }

  const contactId = String(formData.get('contactId') ?? '');
  const sbid = normaliseSbid(String(formData.get('sbid') ?? ''));
  if (!contactId || !sbid) return { error: 'Enter an SBID' };

  const shippingAccountId = await upsertShippingAccountStub(sbid);
  await addContactToShippingAccount({
    contactId,
    shippingAccountId,
    linkSource: 'manual',
    linkedByAgentId: agent.id,
  });

  revalidatePath(`/customers/${contactId}`);
  revalidatePath(`/customers/accounts/${sbid}`);
  return ok();
}

export async function unlinkContactFromAccount(
  _state: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.edit')) {
    return { error: 'You do not have permission to edit customers' };
  }

  const contactId = String(formData.get('contactId') ?? '');
  const shippingAccountId = String(formData.get('shippingAccountId') ?? '');
  if (!contactId || !shippingAccountId) return { error: 'Nothing to unlink' };

  await removeContactFromShippingAccount(contactId, shippingAccountId);

  revalidatePath(`/customers/${contactId}`);
  return ok();
}

/**
 * The manual half of "designate customers as shippers or recipients".
 *
 * The flags are also maintained automatically from the relationship rows, but
 * only additively — so this can turn one off, and the next sync will not turn it
 * back on unless it can prove it. Somebody who knows a contact is a merchant
 * before that merchant has shipped anything needs to be able to say so.
 */
export async function setContactRoles(
  _state: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.edit')) {
    return { error: 'You do not have permission to edit customers' };
  }

  const contactId = String(formData.get('contactId') ?? '');
  if (!contactId) return { error: 'Customer not found' };

  await db
    .update(contacts)
    .set({
      isShipper: formData.get('isShipper') === 'on',
      isRecipient: formData.get('isRecipient') === 'on',
    })
    .where(eq(contacts.id, contactId));

  revalidatePath(`/customers/${contactId}`);
  return ok();
}

/**
 * Names one end of a parcel.
 *
 * The honest form of designating a role: it is recorded against the shipment,
 * where the role actually lives, rather than against the ticket that happened to
 * be open when somebody worked it out.
 */
export async function setShipmentParty(
  _state: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.edit')) {
    return { error: 'You do not have permission to edit customers' };
  }

  const trackingNumber = normaliseTrackingNumber(String(formData.get('trackingNumber') ?? ''));
  const party = String(formData.get('party') ?? '');
  const contactId = String(formData.get('contactId') ?? '').trim();

  if (party !== 'shipper' && party !== 'recipient') return { error: 'Unknown party' };
  if (!trackingNumber) return { error: 'Shipment not found' };

  const rows = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(eq(shipments.trackingNumber, trackingNumber))
    .limit(1);

  const shipment = rows[0];
  if (!shipment) return { error: 'Shipment not found' };

  const previous = await db
    .select({
      shipperContactId: shipments.shipperContactId,
      recipientContactId: shipments.recipientContactId,
    })
    .from(shipments)
    .where(eq(shipments.id, shipment.id))
    .limit(1);

  await db
    .update(shipments)
    .set(
      party === 'shipper'
        ? { shipperContactId: contactId || null }
        : { recipientContactId: contactId || null },
    )
    .where(eq(shipments.id, shipment.id));

  // Both the person named and the person unnamed need re-scoring, or a role
  // stays on somebody who is no longer on the parcel.
  const touched = new Set(
    [contactId, previous[0]?.shipperContactId, previous[0]?.recipientContactId].filter(
      (id): id is string => Boolean(id),
    ),
  );
  for (const id of touched) await refreshContactRoles(id);

  revalidatePath(`/customers/shipments/${trackingNumber}`);
  return ok();
}
