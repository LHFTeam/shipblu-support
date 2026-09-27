'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, shipments } from '@/db/schema';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { purgeContact, type PurgeRefusal } from '@/lib/admin/purge';
import { hiddenScopeRefusal } from '@/lib/admin/purge-visibility';
import { ok, type ActionState } from '@/lib/http/action-state';
import { isUuid } from '@/lib/http/uuid';
import { mergeContacts, type MergeRefusal } from '@/lib/contacts/merge';
import { normaliseSbid, normaliseTrackingNumber } from '@/lib/shipments/format';
import { syncShipment } from '@/lib/shipments/sync';
import {
  addContactToShippingAccount,
  refreshContactRoles,
  removeContactFromShippingAccount,
  upsertShippingAccountStub,
} from '@/lib/shipments/links';

/**
 * Writes from the contact, account and shipment pages.
 *
 * Same shape as the ticket actions: authorise, write, revalidate. Most of these
 * write no `conversation_events` row — they are facts about a person or a parcel
 * rather than about one ticket, and inventing a per-ticket audit entry for them
 * would put the change on whichever ticket happened to be open.
 *
 * A merge is the exception, and it earns it: the ticket's requester genuinely
 * changed, on every ticket that moved, so each one gets an entry of its own.
 */

export type ContactActionState = ActionState;

/**
 * Says that a person can speak for a shipping account.
 *
 * This is the one place a membership is ever asserted. The detector will not do
 * it, however many times somebody types their SBID into a chat, because quoting
 * an account number proves the number came up — not that it is yours.
 */
export async function linkContactToAccount(
  _state: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.edit')) {
    return { error: 'You do not have permission to edit contacts' };
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

  revalidatePath(`/contacts/${contactId}`);
  revalidatePath(`/contacts/accounts/${sbid}`);
  return ok();
}

export async function unlinkContactFromAccount(
  _state: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.edit')) {
    return { error: 'You do not have permission to edit contacts' };
  }

  const contactId = String(formData.get('contactId') ?? '');
  const shippingAccountId = String(formData.get('shippingAccountId') ?? '');
  if (!contactId || !shippingAccountId) return { error: 'Nothing to unlink' };

  await removeContactFromShippingAccount(contactId, shippingAccountId);

  revalidatePath(`/contacts/${contactId}`);
  return ok();
}

/**
 * The manual half of "designate contacts as shippers or recipients".
 *
 * The flags are also maintained automatically from the relationship rows, but
 * only additively — so this can turn one off, and the next sync will not turn it
 * back on unless it can prove it. Somebody who knows a contact is a merchant
 * before that merchant has shipped anything needs to be able to say so.
 */
export async function setContactRoles(
  _state: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.edit')) {
    return { error: 'You do not have permission to edit contacts' };
  }

  const contactId = String(formData.get('contactId') ?? '');
  if (!contactId) return { error: 'Contact not found' };

  await db
    .update(contacts)
    .set({
      isShipper: formData.get('isShipper') === 'on',
      isRecipient: formData.get('isRecipient') === 'on',
    })
    .where(eq(contacts.id, contactId));

  revalidatePath(`/contacts/${contactId}`);
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
  _state: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.edit')) {
    return { error: 'You do not have permission to edit contacts' };
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

  revalidatePath(`/contacts/shipments/${trackingNumber}`);
  return ok();
}

/**
 * Refusal reasons, in words an agent can act on.
 *
 * Every one of these is reachable by two people working the same duplicate at
 * once, not just by a mistake — so they read as "this changed under you" rather
 * than as validation errors.
 */
const MERGE_ERRORS: Record<MergeRefusal, string> = {
  not_found: 'One of those contacts no longer exists',
  same_contact: 'That is the same contact',
  already_merged: 'That contact has already been merged into somebody else — reload the page',
  target_merged: 'This contact has itself been merged away — open the surviving contact instead',
  target_deleted: 'This contact has been deleted, so nothing can be merged into it',
};

/**
 * Folds a duplicate into the contact whose page this is.
 *
 * The direction is fixed by the page rather than chosen in the form: an agent is
 * looking at the record they mean to keep, and a form that could merge either
 * way is a form that will one day retire the wrong one. `contact.merge` rather
 * than `contact.edit`, because this moves another person's tickets and retires a
 * record — the same weight as merging tickets.
 */
export async function mergeContactInto(
  _state: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.merge')) {
    return { error: 'You do not have permission to merge contacts' };
  }

  const survivorId = String(formData.get('survivorId') ?? '');
  const loserId = String(formData.get('loserId') ?? '');
  if (!survivorId || !loserId) return { error: 'Pick a contact to merge' };

  const result = await mergeContacts({ survivorId, loserId, agentId: agent.id });
  if (!result.ok) return { error: MERGE_ERRORS[result.reason] };

  revalidatePath(`/contacts/${survivorId}`);
  // The duplicate's own page is now a redirect to the survivor, and its tickets
  // have moved — so the inbox, and any account page listing its people, are both
  // stale.
  revalidatePath(`/contacts/${loserId}`);
  revalidatePath('/contacts');
  revalidatePath('/inbox');
  return ok();
}

/**
 * Re-read one parcel from the shipping platform, from the shipment page.
 *
 * The same press-and-wait control as the ticket sidebar's and, deliberately, the
 * same `syncShipment` underneath — two buttons that called the platform two ways
 * would eventually disagree about one parcel, which is the failure AGENTS.md's
 * exception is written to prevent.
 *
 * Gated on `contact.view` rather than `contact.edit`: this changes nothing an
 * agent asserted, it re-reads a fact the platform owns and that anyone holding
 * the tracking number can already read. Requiring the edit permission would stop
 * exactly the read-only agent who most needs the button — the one answering the
 * phone.
 */
export async function refreshShipmentDetail(
  _state: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.view')) {
    return { error: 'You do not have permission to view shipments' };
  }

  const trackingNumber = normaliseTrackingNumber(String(formData.get('trackingNumber') ?? ''));
  if (!trackingNumber) return { error: 'Shipment not found' };

  // By tracking number, re-read here: the unique index makes it the parcel's
  // identity, and it is the only field the page had to begin with.
  const result = await syncShipment({ trackingNumber, force: true });

  revalidatePath(`/contacts/shipments/${encodeURIComponent(trackingNumber)}`);

  switch (result.kind) {
    case 'synced':
      return { error: null };
    case 'not_found':
      return { error: 'The shipping platform does not recognise this number' };
    case 'gone':
      return { error: 'Shipment not found' };
    case 'transient':
      return { error: 'The shipping platform could not be reached. Try again in a moment.' };
    case 'refused':
      return { error: `The shipping platform refused the lookup: ${result.error.message}` };
    case 'skipped':
      return { error: null };
  }
}

const PURGE_ERRORS: Record<PurgeRefusal, string> = {
  not_found: 'That contact no longer exists — somebody may have deleted it already',
  confirmation_mismatch: 'That does not match. Type it exactly as shown above.',
};

/**
 * Destroys a customer and every ticket they ever raised.
 *
 * The widest single action in the console, and the only one that deletes rows
 * belonging to a table an agent was not looking at — so it takes `contact.purge`
 * (admin only) and a typed confirmation, which `purgeContact()` re-derives from
 * the locked contact row rather than trusting anything in this form. What the
 * page showed as the blast radius and what the transaction actually finds can
 * differ if a ticket arrived in between, which is exactly why the counts written
 * to the audit trail are the transaction's own, not the preview's.
 *
 * It also applies the channel rule `purgeTicket` gets from `loadConversation()`,
 * and needs it more: the contact page lists this person's tickets through the
 * agent's own visibility filter, so without `hiddenScopeRefusal()` an admin
 * without `ticket.view.bot` would destroy bot transcripts they were never shown.
 */
export async function purgeContactRecord(
  _state: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const agent = await requireAgent();
  if (!can(agent, 'contact.purge')) {
    return { error: 'You do not have permission to delete contacts' };
  }

  const contactId = String(formData.get('contactId') ?? '');
  if (!isUuid(contactId)) return { error: 'No contact to delete' };

  const hidden = await hiddenScopeRefusal(agent, { contactId });
  if (hidden) return { error: hidden };

  const result = await purgeContact({
    contactId,
    confirmation: String(formData.get('confirmation') ?? ''),
    agent: { id: agent.id, name: agent.name },
  });

  if (!result.ok) return { error: PURGE_ERRORS[result.reason] };

  // The inbox loses every ticket this person raised, and any shipment page that
  // named them now shows an unset party.
  revalidatePath('/contacts');
  revalidatePath('/inbox');
  revalidatePath('/admin/categories/review');
  revalidatePath('/contacts/shipments');

  // Redirected from the action rather than by the panel, for the reason
  // `purgeTicket` gives: a revalidating action re-renders the page it was posted
  // from, this contact's page no longer resolves, and its notFound() would land
  // before a client-side navigation could run. Last, because it throws.
  redirect('/contacts');
}
