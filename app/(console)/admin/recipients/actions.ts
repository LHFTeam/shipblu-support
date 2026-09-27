'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { internalRecipients, sideConversations } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
import { errorMessage } from '@/lib/errors';
import { GONE, type SettingsState } from '../settings-shared';

// --- Internal recipients ----------------------------------------------------

/**
 * The directory a side conversation is addressed from.
 *
 * This screen exists so that reaching the Downtown hub is a choice from a list
 * rather than an address typed from memory. The difference is not convenience:
 * `hub-downton@shipblu.com` is a live domain somebody else could own, and the
 * mail sent there carries a customer's name, their address and their complaint.
 *
 * Deactivated rather than deleted while any thread points at one, on the same
 * rule as every other row on these screens — and with a second reason here.
 * `side_conversations.recipient_id` is `ON DELETE SET NULL`, so deleting a hub
 * would blank the recipient on every thread ever sent to it, turning last
 * month's record of who was asked into a row of nulls.
 */
export async function saveInternalRecipient(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.channels');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  // Lowercased on write, because the unique index and every lookup compare the
  // canonical form — the same discipline contact_identities needs.
  const email = text(formData, 'email').toLowerCase();
  const kind = String(formData.get('kind') ?? 'hub');
  const description = text(formData, 'description') || null;
  const isActive = formData.get('isActive') === 'on';

  if (!name) return { error: 'Give this recipient a name agents will recognise' };
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) {
    return { error: 'Enter a valid email address' };
  }
  // No 'hub'. A hub is a `locations` row, which is a register somebody else's
  // screen owns; letting one be entered here would mean the Downtown hub's
  // address is maintained in two places with nothing keeping them in step.
  if (!['team', 'vendor'].includes(kind)) return { error: 'Unknown kind' };

  const values = {
    name,
    email,
    kind: kind as 'team' | 'vendor',
    description,
    isActive,
  };

  try {
    if (id) {
      await db.update(internalRecipients).set(values).where(eq(internalRecipients.id, id));
    } else {
      await db.insert(internalRecipients).values(values);
    }
  } catch (error) {
    // Both name and email are unique. Two entries for one hub is worse than it
    // sounds: the picker shows the same words twice and an agent has no way to
    // tell which is the address anyone reads.
    const message = errorMessage(error);
    if (message.includes('internal_recipients_email_idx')) {
      return { error: 'Another recipient already uses that address' };
    }
    if (message.includes('internal_recipients_name_idx')) {
      return { error: 'Another recipient already has that name' };
    }
    throw error;
  }

  revalidatePath('/admin/recipients');
  return ok();
}

export async function deleteInternalRecipient(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.channels');

  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  const inUse = await db
    .select({ id: sideConversations.id })
    .from(sideConversations)
    .where(eq(sideConversations.recipientId, id))
    .limit(1);

  if (inUse.length > 0) {
    // Deactivated instead, so the picker loses it and the history keeps it.
    await db
      .update(internalRecipients)
      .set({ isActive: false })
      .where(eq(internalRecipients.id, id));

    revalidatePath('/admin/recipients');
    return {
      error:
        'That recipient has side conversations, so it was deactivated rather than deleted. It is gone from the picker and the old threads still say who was asked.',
    };
  }

  await db.delete(internalRecipients).where(eq(internalRecipients.id, id));

  revalidatePath('/admin/recipients');
  return ok();
}
