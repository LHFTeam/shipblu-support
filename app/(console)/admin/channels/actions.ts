'use server';

import { and, eq, ne, sql, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { channels, whatsappAccounts, groups } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { ok } from '@/lib/http/action-state';
import { text, uuidField } from '@/lib/http/form-data';
import { allow } from '@/lib/http/rate-limit';
import { enqueue } from '@/lib/queue';
import { parseTokenEnvVar } from '@/lib/whatsapp/accounts';
import {
  canRequestSync,
  parseCoexistence,
  SYNC_TYPES,
  type SyncType,
} from '@/lib/whatsapp/coexistence';
import { whatsappEditColumns } from '@/lib/whatsapp/coexistence-state';
import {
  forgetStoredCredential as forgetCredential,
  removeStoredCredential,
  storedCredentialEditRefusal,
  storedCredentialRemovalRefusal,
} from '@/lib/whatsapp/credentials';
import { beginCoexistenceOnboarding, retryOnboarding } from '@/lib/whatsapp/onboarding';
import { copyRequestRefusal } from '@/lib/whatsapp/onboarding-reads';
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
 *
 * An account connected through Meta's Embedded Signup has a sealed credential
 * instead, and this never writes one. It refuses the two edits that would break
 * it — naming a variable beside it, and moving it to another WABA id — with the
 * check and the update in one transaction, so a credential stored in between
 * cannot be overwritten by a form rendered before it existed.
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

  const outcome: { refusal: string } | { rows: { id: string }[] } = id
    ? await db.transaction(async (tx) => {
        const refusal = await storedCredentialEditRefusal(tx, id, {
          wabaId,
          tokenEnvVar: token.value,
        });
        if (refusal) return { refusal };

        const rows = await tx
          .update(whatsappAccounts)
          .set(values)
          .where(eq(whatsappAccounts.id, id))
          .returning({ id: whatsappAccounts.id });
        return { rows };
      })
    : {
        rows: await db
          .insert(whatsappAccounts)
          .values(values)
          .returning({ id: whatsappAccounts.id }),
      };

  if ('refusal' in outcome) return { error: outcome.refusal };

  const savedId = outcome.rows[0]?.id;
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
 *
 * A stored credential goes with it too — by cascade, whatever this does — and
 * removing one is what `admin.channels.connect` hands out (`forgetStoredCredential`
 * asks for it). So an account holding one is disconnected only by somebody who
 * holds that key; anybody else would have a Forget button by another name the
 * day the two keys are given to different roles.
 */
export async function deleteWhatsAppAccount(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const agent = await requirePermission('admin.channels');

  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };
  const mayForget = can(agent, 'admin.channels.connect');

  const numbers = await db
    .select({ name: channels.name, type: channels.type, config: channels.config })
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

    // "Point them elsewhere" is not something the editor can do for a number
    // connected through Meta (`saveChannel` keeps its account), so those are
    // named with the way they do move.
    const connected = numbers.filter(
      (number) => number.type === 'whatsapp' && parseCoexistence(number.config),
    );
    const names = (rows: typeof numbers) => rows.map((number) => number.name).join(', ');
    const howConnectedMove =
      connected.length === 0
        ? '.'
        : ` — ${names(connected)} ${connected.length === 1 ? 'was' : 'were'} connected ` +
          `through Meta, and ${connected.length === 1 ? 'moves' : 'move'} only by connecting ` +
          `again through Meta with the other account.`;
    refresh('/admin/channels');
    return {
      error:
        `${names(numbers)} still send on that business account, so it was switched off rather ` +
        `than disconnected. Point them at another business account first${howConnectedMove}`,
    };
  }

  // A stored credential goes with the account by cascade; removing it first, in
  // the same transaction, is what records who disconnected it — the audit row
  // outlives both. Whether this caller may is decided under the account row's
  // lock, the one a connection storing a credential takes, so a credential
  // stored while the page was open is counted rather than cascaded away.
  const refusal = await db.transaction(async (tx) => {
    const refused = await storedCredentialRemovalRefusal(tx, id, mayForget);
    if (refused) return refused;
    await removeStoredCredential(tx, id, { id: agent.id, label: agent.name });
    await tx.delete(whatsappAccounts).where(eq(whatsappAccounts.id, id));
    return null;
  });
  if (refusal) return { error: refusal };

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
  let existing: { config: Record<string, unknown>; whatsappAccountId: string | null } | null = null;
  if (rawId) {
    if (!id) return { error: 'That form is out of date — reload the page and try again' };

    const [row] = await db
      .select({
        type: channels.type,
        config: channels.config,
        whatsappAccountId: channels.whatsappAccountId,
      })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (!row) return { error: 'That channel no longer exists' };
    type = row.type;
    existing = row;
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

  // A number connected through Meta's Embedded Signup sends with the
  // credential stored for the business account it was connected to, so that
  // link is not the form's to change: pointed at another account, its replies
  // would go out authenticated as a different WABA, and a disconnection on the
  // phone would be recorded against the wrong credential. The editor shows the
  // account as text and submits the stored id; anything else is refused here
  // with the way to move it — and kept regardless by `whatsappEditColumns`
  // below, which also covers a channel the job adopted after this read.
  const coexistence = type === 'whatsapp' && existing ? parseCoexistence(existing.config) : null;

  if (coexistence && existing) {
    const chosen = whatsappAccountId
      ? (canonicalUuid(whatsappAccountId) ?? whatsappAccountId)
      : null;
    if (chosen !== existing.whatsappAccountId) {
      return {
        error:
          `This number was connected through Meta to business account ${coexistence.wabaId} ` +
          `and sends with the credential stored for it, so it cannot be moved to another here. ` +
          `To move it, connect it again through Meta and choose the other business account.`,
      };
    }
  } else if (isWhatsApp) {
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
    // An edit of a `whatsapp` row leaves its config and account to the
    // database. A number connected through Meta carries a `coexistence` object
    // the job wrote and the history webhooks keep moving, and its phone number
    // id is what Meta reported; rebuilding `config` as `{phoneNumberId}` is how
    // a rename used to wipe the connection, and copying it from the read above
    // wrote back a snapshot over every update that landed since.
    // `whatsappEditColumns` keeps both as the row holds them when the UPDATE
    // runs, and writes the form's for any other number.
    const columns =
      type === 'whatsapp'
        ? whatsappEditColumns({ phoneNumberId, whatsappAccountId: account })
        : { config, whatsappAccountId: account };
    await db
      .update(channels)
      .set({ name, defaultGroupId, ...columns, updatedAt: new Date() })
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
  return ok();
}

// --- Numbers on the WhatsApp Business app -----------------------------------

/**
 * The first phase of connecting a number through Meta's window: the browser
 * hands over the sign-in code and the ids the window named, and
 * `beginCoexistenceOnboarding` exchanges, proves, seals and records them, all
 * inside the thirty seconds the code lives (AGENTS.md, Background work, on
 * the two exceptions). The job does the rest.
 *
 * Every field is a claim from a browser. The code is never echoed and never
 * logged — the lib names host and path in every sentence it builds — and the
 * ids are proven server-side before anything is written. `admin.channels.connect`
 * rather than `admin.channels`, because this stores a credential and imports
 * six months of a business's chats; and five attempts per admin per ten
 * minutes, because each one spends a code and every refusal names what to fix.
 */
export async function connectBusinessAppNumber(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const agent = await requirePermission('admin.channels.connect');

  if (!allow(`signup:${agent.id}`, 5, 10 * 60 * 1000)) {
    return {
      error: 'Too many attempts — wait ten minutes before connecting again.',
      wait: true,
    };
  }

  const defaultGroupId = uuidField(formData, 'defaultGroupId');
  if (defaultGroupId === undefined) return { error: 'Unknown default group' };
  if (defaultGroupId) {
    const [group] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, defaultGroupId))
      .limit(1);
    if (!group) return { error: 'That default group no longer exists — reload the page' };
  }

  const outcome = await beginCoexistenceOnboarding(
    {
      code: text(formData, 'code'),
      wabaId: text(formData, 'wabaId'),
      phoneNumberId: text(formData, 'phoneNumberId') || null,
      defaultGroupId,
    },
    { id: agent.id, name: agent.name },
  );

  if (!outcome.ok) return { error: outcome.error, wait: outcome.wait };

  refresh('/admin/channels');
  return { ...ok(), notice: outcome.notice, onboardingId: outcome.onboardingId };
}

/**
 * "Retry connection" — the same job again, no popup: the credential is stored,
 * so nothing the browser had is needed. For a failed attempt, and for one still
 * `exchanged` past fifteen minutes whose job is gone, which nothing else would
 * ever move. The lib refuses an attempt a newer one has replaced, one still
 * inside its fifteen minutes, and one whose job is still queued — that last
 * with a sentence naming the worker, since retrying it again would not help.
 */
export async function retryCoexistenceOnboarding(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.channels.connect');

  const onboardingId = uuidField(formData, 'onboardingId');
  if (!onboardingId) return { error: GONE };

  const outcome = await retryOnboarding(onboardingId);
  if (!outcome.ok) return { error: outcome.error };

  refresh('/admin/channels');
  return {
    ...ok(),
    notice: 'Connecting the number again — the progress below updates as it goes.',
  };
}

/**
 * "Copy the contacts / history again" on a connected number: the job's copy
 * step alone, inside the 24-hour window.
 *
 * The channel is re-read and judged here with the same `canRequestSync` the
 * job uses, so the button and the job cannot disagree about whether a copy
 * may be asked for — and the job judges again when it runs, because the
 * window can close between the click and the claim. What is enqueued names
 * the attempt that connected the channel (`coexistence.onboardingId`), and the
 * job runs named steps only on an attempt that finished connecting — so that
 * is asked here too (`copyRequestRefusal`), or a click on a number still
 * connecting would be told the copy was on its way while the job skipped it.
 */
export async function requestCoexistenceSync(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.channels.connect');

  const channelId = uuidField(formData, 'channelId');
  if (!channelId) return { error: GONE };

  const syncType = text(formData, 'syncType');
  if (!(SYNC_TYPES as readonly string[]).includes(syncType)) {
    return { error: 'Unknown copy type' };
  }
  const type = syncType as SyncType;

  const [channel] = await db
    .select({ config: channels.config })
    .from(channels)
    .where(
      and(eq(channels.id, channelId), eq(channels.type, 'whatsapp'), eq(channels.isActive, true)),
    )
    .limit(1);
  if (!channel) return { error: 'That channel is not an active WhatsApp number — reload the page' };

  const coexistence = parseCoexistence(channel.config);
  if (!coexistence?.onboardingId) {
    return {
      error:
        'This number was not connected through Meta from here, so there is no connection to ' +
        'ask the phone through. Connect it with "Connect a WhatsApp number".',
    };
  }

  const permission = canRequestSync(coexistence, type, new Date());
  if (!permission.ok) return { error: permission.sentence };

  const refusal = await copyRequestRefusal(coexistence.onboardingId);
  if (refusal) return { error: refusal };

  await enqueue(
    'complete_coexistence_onboarding',
    { onboardingId: coexistence.onboardingId, steps: [type] },
    { priority: 10 },
  );

  refresh('/admin/channels');
  return {
    ...ok(),
    notice: `Asked the phone for its ${
      type === 'contacts' ? 'contacts' : 'chat history'
    } — this page updates as it arrives. Keep the WhatsApp Business app open on the phone.`,
  };
}

/**
 * "Forget credential" on a business account: deletes the sealed token and
 * records who did it, leaving the account and its numbers. The account then
 * sends with META_PAGE_ACCESS_TOKEN — not with a token variable: storing the
 * credential cleared the one it named, and the save refuses one while a
 * credential is stored, so a row written through the console has none to fall
 * back to. That token reaches a different business unless the WABA sits under
 * this app, which `ForgetCredential`'s hint and confirmation say, because they
 * are all the admin reads: on success the control unmounts with the
 * credential it was shown for, and `DangerAction` prints only errors, so a
 * notice here would never be seen. Nothing at Meta changes; the lib says why,
 * and the hint says where that is done.
 */
export async function forgetStoredCredential(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const agent = await requirePermission('admin.channels.connect');

  const id = uuidField(formData, 'id');
  if (!id) return { error: GONE };

  const removed = await forgetCredential(id, { id: agent.id, label: agent.name });
  if (!removed) return { error: 'No credential is stored for that business account.' };

  refresh('/admin/channels');
  return ok();
}
