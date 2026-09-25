'use server';

import { revalidatePath } from 'next/cache';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  channels,
  invites,
  jobs,
  ticketCategories,
  ticketRootCauses,
  whatsappAccounts,
} from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { forgetCategoryIds } from '@/lib/categorise/apply';
import { looksLikeEmail, normaliseEmail } from '@/lib/auth/normalise';
import { sealInviteToken } from '@/lib/auth/invite-token';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { destroyAllSessionsForAgent } from '@/lib/auth/session';
import { listFolderOptions } from '@/lib/kb/admin';
import { LOCALES } from '@/lib/kb/locale';
import { resolveFaqFolders } from '@/lib/widget/config';
import { enqueue } from '@/lib/queue';
import { appUrl, env } from '@/lib/env';

export type AdminState = {
  error: string | null;
  inviteUrl?: string;
  /**
   * The address an invitation was *queued* for, present only when it was.
   *
   * Named for the queue rather than the send because that is all this action
   * can honestly report: the worker still has to run, and Postmark still has
   * to accept the recipient. Distinct from `inviteUrl`, which comes back
   * either way — the admin has to be told which of the two happened, because
   * "it is on its way" and "nothing was sent, send this yourself" call for
   * opposite next actions.
   */
  inviteQueuedFor?: string;
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A cap on the invited name, checked server-side because the action is
 * reachable without the form. Unbounded, it would reach `invites.name`, then
 * `agents.name`, and from there every inbox row and assignment dropdown that
 * renders an agent — one paste of a large clipboard buffer away.
 */
const MAX_INVITE_NAME = 120;

/**
 * Creates an invite, emails the invitee a link to activate it, and returns that
 * link to the admin as well.
 *
 * Both, not either. The email is how an invite is delivered, but it is only
 * attempted when `EMAIL_FROM_ADDRESS` is configured — and the one moment that
 * is guaranteed *not* to be true is a fresh deploy adding its first agents,
 * which is exactly when invites have to work. So the link keeps coming back for
 * the admin to send by hand, and the return value says which of the two
 * happened rather than leaving them to guess.
 *
 * The token's hash handles acceptance and an encrypted copy lets the same link
 * remain on the pending-invites screen without making a database dump
 * sufficient to use it.
 */
export async function createInvite(_state: AdminState, formData: FormData): Promise<AdminState> {
  const admin = await requirePermission('admin.agents');

  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const name = String(formData.get('name') ?? '').trim();
  const role = String(formData.get('role') ?? 'agent');

  // `looksLikeEmail`, not `includes('@')`: the send path validates with
  // `z.email()`, which rejects `foo@` and `@b.com`. Accepting them here would
  // commit the invite, tell the admin it was emailed, and leave the job to die
  // in the worker where they will never see it.
  if (!looksLikeEmail(email)) return { error: 'Enter a valid email address' };
  // `required` on the input is a courtesy to whoever is typing, not a
  // constraint — the action is reachable without it. Checked here because
  // `invites.name` is NOT NULL and a blank one would otherwise reach the
  // insert as '', which satisfies the column and satisfies nobody else.
  if (!name) return { error: 'Enter the name of the person you are inviting' };
  if (name.length > MAX_INVITE_NAME) {
    return { error: `A name cannot be longer than ${MAX_INVITE_NAME} characters` };
  }
  if (!['agent', 'supervisor', 'admin', 'account_admin'].includes(role)) {
    return { error: 'Unknown role' };
  }

  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.email, email))
    .limit(1);
  if (existing.length > 0) return { error: 'That agent already exists' };

  let inviteBaseUrl: string;
  try {
    // Resolve the configuration before superseding a working invite. Calling
    // this after the writes would leave a new row behind while returning an
    // error with no URL for the admin to send.
    inviteBaseUrl = appUrl();
  } catch {
    return { error: 'APP_URL must be configured before creating an invite' };
  }

  const token = generateToken();
  const tokenCiphertext = sealInviteToken(token, env().APP_SECRET);
  // One value for the row and for the email. Recomputing the deadline for the
  // message would put a date in the invitee's inbox that is minutes off the one
  // the database will enforce, and the copy would stop matching the
  // pending-invites screen the moment the TTL changed.
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const inviteId = await db.transaction(async (tx) => {
    // Supersede any open invite for the same address, so a resend does not leave
    // two working links with different roles. Delete and insert are one unit:
    // an insertion failure must leave the existing invitation usable.
    await tx.delete(invites).where(and(eq(invites.email, email), isNull(invites.acceptedAt)));

    const inserted = await tx
      .insert(invites)
      .values({
        tokenHash: hashToken(token),
        tokenCiphertext,
        email,
        name,
        role: role as 'agent' | 'supervisor' | 'admin' | 'account_admin',
        invitedByAgentId: admin.id,
        expiresAt,
      })
      .returning({ id: invites.id });

    return inserted[0]!.id;
  });

  const inviteUrl = `${inviteBaseUrl}/invite/${token}`;

  // After the commit, never inside it. `enqueue` writes on its own connection,
  // so a job queued from inside the transaction would survive a rollback and
  // point the worker at an invite that does not exist.
  //
  // The payload is the row's id and nothing else. The rendered link must not go
  // in it: `jobs` keeps a completed row for seven days and a dead one forever,
  // so a body containing the activation URL would leave a working credential in
  // plaintext for longer than the invite itself is valid — undoing the whole
  // reason `invites` stores a hash and an AES-GCM envelope instead of a token.
  // `send_agent_invite` rebuilds the link from that envelope.
  //
  // Priority 60, behind ticket replies at 50. `enqueueNotificationEmail` uses 40
  // on the grounds that somebody is sitting on a form waiting for the link,
  // which is exactly what is *not* true here — the admin already has it in this
  // response. A batch of invitations must not overtake customers waiting on an
  // answer.
  //
  // Nothing here may throw. The invite is committed by this point, so an
  // exception would do what the `appUrl()` check above exists to prevent: leave
  // a new row behind and hand the admin an error page with no link on it. A
  // queue insert that fails degrades to the same state as an unconfigured
  // mailbox — the admin is told no email went out and sends the link
  // themselves, which is a working invitation either way.
  let queuedFor: string | null = null;
  if (env().EMAIL_FROM_ADDRESS) {
    try {
      await enqueue('send_agent_invite', { inviteId }, { priority: 60 });
      queuedFor = email;
    } catch (error) {
      // The cause belongs in the logs; the admin only needs to know it is on
      // them to deliver the link, which the response already tells them.
      console.error(`[createInvite] could not queue the invitation email for ${email}`, error);
    }
  }

  revalidatePath('/admin/agents');

  return {
    error: null,
    inviteUrl,
    ...(queuedFor ? { inviteQueuedFor: queuedFor } : {}),
  };
}

export async function setAgentActive(_state: AdminState, formData: FormData): Promise<AdminState> {
  const admin = await requirePermission('admin.agents');

  const agentId = String(formData.get('agentId') ?? '');
  const active = formData.get('active') === 'true';

  // Locking yourself out is always a mistake, and recovering needs shell access.
  if (agentId === admin.id && !active) {
    return { error: 'You cannot deactivate your own account' };
  }

  await db.update(agents).set({ isActive: active }).where(eq(agents.id, agentId));

  // Deactivation must take effect now, not when their cookie expires.
  if (!active) await destroyAllSessionsForAgent(agentId);

  revalidatePath('/admin/agents');
  return { error: null };
}

/**
 * An agent's own ticket cap.
 *
 * Blank clears it, which puts them back on their group's default rather than on
 * "no limit" — the two are different answers and only one of them is a decision
 * about this person.
 *
 * Deliberately not gated behind deactivation or self-editing checks the way
 * `setAgentActive` is: raising your own cap is not a way to lock anybody out,
 * and an admin adjusting their own number while the queue is backing up is the
 * expected use rather than the abuse.
 */
export async function setAgentCapacity(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.agents');

  const agentId = String(formData.get('agentId') ?? '');
  const raw = String(formData.get('maxOpenTickets') ?? '').trim();

  let maxOpenTickets: number | null = null;
  if (raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return { error: 'That is not a number of tickets' };
    maxOpenTickets = Math.trunc(value);
  }

  await db.update(agents).set({ maxOpenTickets }).where(eq(agents.id, agentId));

  revalidatePath('/admin/agents');
  return { error: null };
}

export async function saveChannel(_state: AdminState, formData: FormData): Promise<AdminState> {
  await requirePermission('admin.channels');

  const id = String(formData.get('id') ?? '');
  const name = String(formData.get('name') ?? '').trim();

  // On an edit the type is the stored row's, never the form's. Everything
  // below rebuilds `config` and the account link from the type, so a request
  // naming `email` for a WhatsApp channel's id would otherwise wipe its phone
  // number id and its account, and its inbound traffic would route nowhere —
  // and the same request could rewrite a `portal` or `api` row that no form
  // edits. The form's field only says what to create.
  let type = String(formData.get('type') ?? '');
  if (id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { error: 'That form is out of date — reload the page and try again' };
    }

    const existing = await db
      .select({ type: channels.type })
      .from(channels)
      .where(eq(channels.id, id))
      .limit(1);

    if (!existing[0]) return { error: 'That channel no longer exists' };
    type = existing[0].type;
  }

  const defaultGroupId = String(formData.get('defaultGroupId') ?? '') || null;
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();
  const address = String(formData.get('address') ?? '').trim();
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

/**
 * Queues a Freshdesk knowledge base import.
 *
 * The job runs on the worker, which is where the Freshdesk credentials live —
 * the web service cannot see them, so this deliberately does not try to
 * pre-validate the configuration. An unconfigured worker fails the job with a
 * clear message, which the run list below the button shows.
 */
export async function startFreshdeskImport(
  _state: AdminState,
  _formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.agents');

  // A second import running against the same rows would not corrupt anything —
  // every write is idempotent — but it would double the API calls against
  // Freshdesk's per-minute rate limit and make the logs unreadable.
  const running = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      sql`${jobs.type} = 'import_freshdesk_kb' and ${jobs.status} in ('pending', 'processing')`,
    )
    .limit(1);

  if (running.length > 0) {
    return { error: 'An import is already queued or running.' };
  }

  await enqueue(
    'import_freshdesk_kb',
    {},
    {
      priority: 50,
      // Bucketed to the minute rather than a fixed key: a fixed one would be
      // taken forever by the first run, since completed jobs keep their dedupe
      // key for seven days. This swallows a double-click and still allows a
      // re-run a minute later.
      dedupeKey: `import_freshdesk_kb:${Math.floor(Date.now() / 60_000)}`,
      // The importer is idempotent, so a retry resumes rather than duplicates —
      // but three is enough to ride out a rate limit without hammering
      // Freshdesk for an hour on a bad API key.
      maxAttempts: 3,
    },
  );

  revalidatePath('/admin/import');
  return { error: null };
}

/**
 * Recovers the map pins already sitting in the archive.
 *
 * The live path keeps a pin's coordinates as they arrive, so this is for
 * everything that came before — messages where the pin only ever reached us as
 * text inside `body_text`, which an agent cannot open on a map.
 *
 * Guarded the same way as the shipment backfill and for the same reason: it is
 * idempotent and re-running it costs nothing but a pass over the archive, so the
 * only thing worth preventing is two of them at once.
 */
export async function startLocationBackfill(
  _state: AdminState,
  _formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.agents');

  const running = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      sql`${jobs.type} = 'backfill_message_locations' and ${jobs.status} in ('pending', 'processing')`,
    )
    .limit(1);

  if (running.length > 0) {
    return { error: 'A location backfill is already queued or running.' };
  }

  await enqueue(
    'backfill_message_locations',
    {},
    {
      // Behind anything a customer is waiting on.
      priority: 80,
      dedupeKey: `backfill_message_locations:${Math.floor(Date.now() / 60_000)}`,
      maxAttempts: 2,
    },
  );

  revalidatePath('/admin/import');
  return { error: null };
}

/**
 * Scans the archive for tracking numbers and SBIDs nobody has linked yet.
 *
 * Also the way a corrected detection pattern reaches history: the live path only
 * ever sees new messages, so widening the pattern without re-running this leaves
 * every ticket that arrived before the change unlinked.
 *
 * Whether a re-run finds anything new is the point, and it costs nothing when it
 * does not — every write underneath is idempotent — so this is not guarded as
 * tightly as the Freshdesk import, which spends someone else's rate limit.
 */
export async function startShipmentBackfill(
  _state: AdminState,
  _formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.agents');

  const running = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      sql`${jobs.type} = 'backfill_shipment_links' and ${jobs.status} in ('pending', 'processing')`,
    )
    .limit(1);

  if (running.length > 0) {
    return { error: 'A backfill is already queued or running.' };
  }

  await enqueue(
    'backfill_shipment_links',
    {},
    {
      // Behind anything a customer is waiting on. This reads the whole message
      // archive and there is no hurry about it.
      priority: 80,
      dedupeKey: `backfill_shipment_links:${Math.floor(Date.now() / 60_000)}`,
      // It resumes from the start rather than from where it stopped, and every
      // write is idempotent, so a retry is cheap — but a third attempt against a
      // genuine bug is just three passes over the archive.
      maxAttempts: 2,
    },
  );

  revalidatePath('/admin/import');
  return { error: null };
}

// --- Categories and root causes ---------------------------------------------

/**
 * Renaming a category, and taking one out of use.
 *
 * The labels are the whole reason this is a table rather than a constant, so
 * they are editable. Three things are not, and each would break something
 * silently:
 *
 * - **`key`.** Every compiled rule in `lib/categorise/rules.ts` awards one,
 *   every stored assignment freezes one, and every report groups by one. Editing
 *   it would leave the rules pointing at nothing *and* strand the value on every
 *   ticket already filed under it, with nothing reporting an error.
 * - **`area`.** A CHECK ties it to the key, so a change here would be rejected
 *   by the database rather than accepted and wrong. Structural, not editorial.
 * - **`owner`** on a cause, for the same reason: the prefix of the key names it,
 *   and a CHECK holds them together.
 *
 * There is no delete. The foreign key from `conversation_categories` is
 * `restrict`, so a category with tickets behind it cannot be removed at all —
 * deactivating takes it out of the picker and leaves every report ever drawn
 * from it still readable.
 */
export async function saveCategory(_state: AdminState, formData: FormData): Promise<AdminState> {
  await requirePermission('admin.categories');

  const id = String(formData.get('id') ?? '');
  const labelEn = String(formData.get('labelEn') ?? '').trim();
  const labelAr = String(formData.get('labelAr') ?? '').trim();

  if (!id) return { error: 'Unknown category' };
  if (!labelEn || !labelAr) {
    // Both, always. Arabic is the default locale and the labels are what a
    // report shown to an Egyptian operations lead is read in, so a blank Arabic
    // label is a broken report rather than a cosmetic gap.
    return { error: 'Both the English and the Arabic label are required' };
  }

  await db
    .update(ticketCategories)
    .set({ labelEn, labelAr, updatedAt: new Date() })
    .where(eq(ticketCategories.id, id));

  forgetCategoryIds();
  revalidatePath('/admin/categories');
  return { error: null };
}

export async function setCategoryActive(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.categories');

  const id = String(formData.get('id') ?? '');
  const active = formData.get('active') === 'true';
  if (!id) return { error: 'Unknown category' };

  await db
    .update(ticketCategories)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(ticketCategories.id, id));

  // Retiring a category is how somebody stops an over-firing rule filling a
  // report, so the detector has to stop assigning it — not just the picker stop
  // offering it. This clears the registry cache in the web service; the worker,
  // which is where the detector actually runs, picks the change up on its own
  // cache's TTL. See `categoryIds()`.
  forgetCategoryIds();
  revalidatePath('/admin/categories');
  return { error: null };
}

export async function saveRootCause(_state: AdminState, formData: FormData): Promise<AdminState> {
  await requirePermission('admin.categories');

  const id = String(formData.get('id') ?? '');
  const labelEn = String(formData.get('labelEn') ?? '').trim();
  const labelAr = String(formData.get('labelAr') ?? '').trim();

  if (!id) return { error: 'Unknown cause' };
  if (!labelEn || !labelAr) {
    return { error: 'Both the English and the Arabic label are required' };
  }

  await db
    .update(ticketRootCauses)
    .set({ labelEn, labelAr, updatedAt: new Date() })
    .where(eq(ticketRootCauses.id, id));

  revalidatePath('/admin/categories');
  return { error: null };
}

export async function setRootCauseActive(
  _state: AdminState,
  formData: FormData,
): Promise<AdminState> {
  await requirePermission('admin.categories');

  const id = String(formData.get('id') ?? '');
  const active = formData.get('active') === 'true';
  if (!id) return { error: 'Unknown cause' };

  await db
    .update(ticketRootCauses)
    .set({ isActive: active, updatedAt: new Date() })
    .where(eq(ticketRootCauses.id, id));

  revalidatePath('/admin/categories');
  return { error: null };
}
