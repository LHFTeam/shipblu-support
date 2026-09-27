'use server';

import { and, eq, ne, sql, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, whatsappAccounts, groups } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
import { parseTokenEnvVar } from '@/lib/whatsapp/accounts';
import { GONE, refresh, type SettingsState, type AdminState } from '../settings-shared';
import { revalidatePath } from 'next/cache';
import { canonicalUuid } from '@/lib/http/uuid';
import { listFolderOptions } from '@/lib/kb/admin';
import { LOCALES } from '@/lib/kb/locale';
import { resolveFaqFolders } from '@/lib/widget/config';

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

export async function saveChannel(_state: AdminState, formData: FormData): Promise<AdminState> {
  await requirePermission('admin.channels');

  const rawId = String(formData.get('id') ?? '');
  const id = canonicalUuid(rawId);
  const name = text(formData, 'name');

  // On an edit the type is the stored row's, never the form's. Everything
  // below rebuilds `config` and the account link from the type, so a request
  // naming `email` for a WhatsApp channel's id would otherwise wipe its phone
  // number id and its account, and its inbound traffic would route nowhere —
  // and the same request could rewrite a `portal` or `api` row that no form
  // edits. The form's field only says what to create.
  let type = String(formData.get('type') ?? '');
  if (rawId) {
    if (!id) return { error: 'That form is out of date — reload the page and try again' };

    const existing = await db
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (!existing[0]) return { error: 'That channel no longer exists' };
    type = existing[0].type;
  }

  // Re-read rather than written as given: Postgres answers a malformed uuid with
  // 22P02 and a deleted group with a foreign-key violation, and either is a
  // throw where the form promises a sentence. The whatsapp account below is
  // re-read the same way.
  const rawGroupId = String(formData.get('defaultGroupId') ?? '');
  const defaultGroupId = rawGroupId ? canonicalUuid(rawGroupId) : null;
  if (rawGroupId && !defaultGroupId) return { error: 'Unknown default group' };
  if (defaultGroupId) {
    const [group] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, defaultGroupId))
      .limit(1);
    if (!group) return { error: 'That default group no longer exists — reload the page' };
  }
  const phoneNumberId = text(formData, 'phoneNumberId');
  const address = text(formData, 'address');
  const whatsappAccountId = String(formData.get('whatsappAccountId') ?? '') || null;

  if (!name) return { error: 'Give the channel a name' };
  if (!['email', 'whatsapp', 'webchat', 'facebook', 'instagram', 'whatsapp_bot'].includes(type)) {
    return { error: id ? 'This channel is not edited here' : 'Unknown channel type' };
  }

  // The phone number id is what routes an inbound event to this channel, so a
  // bot channel without one would match nothing and its messages would arrive as
  // ordinary WhatsApp tickets the team can reply to. Required, not defaulted.
  if (type === 'whatsapp_bot' && !phoneNumberId) {
    return { error: 'A customer bot channel needs the phone number ID it receives on' };
  }

  const isWhatsApp = type === 'whatsapp' || type === 'whatsapp_bot';

  if (isWhatsApp) {
    // Re-read rather than trusted: the id arrives in a FormData field, and a
    // number pointed at a business account that does not exist would send with
    // a token that has no access to it.
    const accounts = await db
      .select({ id: whatsappAccounts.id })
      .from(whatsappAccounts)
      .orderBy(asc(whatsappAccounts.name));

    if (whatsappAccountId && !accounts.some((row) => row.id === whatsappAccountId)) {
      return { error: 'That WhatsApp business account no longer exists' };
    }

    // Required once there is anything to choose from, so an unset link means
    // "configured before there were accounts" and nothing else — which is what
    // lets the adoption in `ensureEnvironmentAccount` claim those rows without
    // also sweeping up ones an admin left blank on purpose.
    if (accounts.length > 0 && !whatsappAccountId) {
      return { error: 'Choose which WhatsApp business account this number belongs to' };
    }
  }

  // Which knowledge base folder the chat widget lists, per locale. The rule
  // lives in `lib/widget/config.ts`, shared with the picker that offers them.
  let faqFolders: Record<string, string> = {};

  if (type === 'webchat') {
    const chosen = Object.fromEntries(
      LOCALES.map((locale) => [locale, String(formData.get(`faqFolder_${locale}`) ?? '')]),
    );

    const resolved = resolveFaqFolders(chosen, await listFolderOptions());
    if ('error' in resolved) return { error: resolved.error };
    faqFolders = resolved.folders;
  }

  // Non-secret settings only. Access tokens and app secrets stay in the
  // environment, so a database dump never contains a usable credential.
  // Facebook and Instagram are addressed by ids that live in the environment
  // beside the token they are useless without, so their row carries routing
  // only.
  const config =
    type === 'whatsapp' || type === 'whatsapp_bot'
      ? { phoneNumberId }
      : type === 'facebook' || type === 'instagram'
        ? {}
        : type === 'webchat'
          ? // The widget has no address. The row used to store an empty one
            // because this branch was the catch-all; production still carries
            // `{"address": ""}` from that, and this replaces it.
            { faqFolders }
          : { address };

  const account = isWhatsApp ? whatsappAccountId : null;

  if (id) {
    await db
      .update(channels)
      .set({ name, defaultGroupId, config, whatsappAccountId: account, updatedAt: new Date() })
      .where(eq(channels.id, id));
  } else {
    await db.insert(channels).values({
      type: type as (typeof channels.$inferInsert)['type'],
      name,
      defaultGroupId,
      config,
      whatsappAccountId: account,
    });
  }

  revalidatePath('/admin/channels');
  return { error: null };
}
