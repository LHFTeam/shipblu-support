'use server';

import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, whatsappAccounts } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
import { parseTokenEnvVar } from '@/lib/whatsapp/accounts';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- WhatsApp business accounts ---------------------------------------------

/**
 * Connect or edit one WABA.
 *
 * The row holds ids and a *name* of an environment variable, never a token —
 * the same rule the channels table follows. `parseTokenEnvVar` is what enforces
 * it: an admin free to type any variable name would be choosing which of the
 * process's secrets gets posted to Meta as a bearer token, and would never see
 * the value to know it had happened.
 */
export async function saveWhatsAppAccount(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.channels');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  const wabaId = text(formData, 'wabaId');
  const isDefault = formData.get('isDefault') === 'on';
  const isActive = formData.get('isActive') === 'on';

  if (!name) return { error: 'Give the business account a name' };
  // Meta's ids are numeric strings. Checked because the failure otherwise is a
  // Graph 400 an hour later in the cron log, not here where it can be fixed.
  if (!/^\d{5,}$/.test(wabaId)) {
    return {
      error:
        'The WhatsApp Business Account ID is the numeric id from Meta’s WhatsApp Manager — not the phone number and not the name.',
    };
  }

  const token = parseTokenEnvVar(String(formData.get('tokenEnvVar') ?? ''));
  if (!token.ok) return { error: token.error };

  const clash = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(and(eq(whatsappAccounts.wabaId, wabaId), id ? ne(whatsappAccounts.id, id) : sql`true`))
    .limit(1);

  if (clash.length > 0) {
    return { error: 'Another connection already uses that business account id.' };
  }

  const values = {
    name,
    wabaId,
    tokenEnvVar: token.value,
    isDefault,
    isActive,
    updatedAt: new Date(),
  };

  const saved = id
    ? await db
        .update(whatsappAccounts)
        .set(values)
        .where(eq(whatsappAccounts.id, id))
        .returning({ id: whatsappAccounts.id })
    : await db.insert(whatsappAccounts).values(values).returning({ id: whatsappAccounts.id });

  const savedId = saved[0]?.id;
  if (!savedId) return { error: 'That business account no longer exists.' };

  // Exactly one default, enforced here rather than by a partial unique index:
  // the index would reject the *save* that creates the second default and leave
  // the admin to work out which existing row to clear first, when what they
  // asked for is unambiguous.
  if (isDefault) {
    await db
      .update(whatsappAccounts)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(ne(whatsappAccounts.id, savedId));
  }

  refresh('/admin/channels');
  return ok();
}

/**
 * Disconnect a WABA.
 *
 * Its templates go with it — they are a cache of what that account holds, and
 * with the account gone there is no number left to send them from. Numbers
 * pointing at it are detached by the `set null` on the foreign key rather than
 * deleted: a channel row is where a ticket's history is anchored, and taking it
 * with the connection would orphan every conversation that arrived on it.
 */
export async function deleteWhatsAppAccount(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.channels');

  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  const numbers = await db
    .select({ name: channels.name })
    .from(channels)
    .where(and(eq(channels.whatsappAccountId, id), eq(channels.isActive, true)));

  if (numbers.length > 0) {
    // Deactivated rather than deleted, for the same reason as everywhere else
    // in this file: the numbers would silently fall back to the default account
    // and start replying from the wrong business — which Meta rejects on a
    // status webhook nobody is watching.
    await db
      .update(whatsappAccounts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(whatsappAccounts.id, id));

    refresh('/admin/channels');
    return {
      error: `${numbers.map((number) => number.name).join(', ')} still send on that business account, so it was switched off rather than disconnected. Point them somewhere else first.`,
    };
  }

  await db.delete(whatsappAccounts).where(eq(whatsappAccounts.id, id));

  refresh('/admin/channels');
  return ok();
}
