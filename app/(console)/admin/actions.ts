'use server';

import { revalidatePath } from 'next/cache';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, channels, invites, jobs, whatsappAccounts } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { normaliseEmail } from '@/lib/auth/normalise';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { destroyAllSessionsForAgent } from '@/lib/auth/session';
import { enqueue } from '@/lib/queue';
import { appUrl } from '@/lib/env';

export type AdminState = { error: string | null; inviteUrl?: string };

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Creates an invite and returns the link.
 *
 * The raw token is shown once, here, and only its hash is stored — so the link
 * is displayed to the admin rather than emailed for now. That also means invites
 * work before the email channel is configured, which is exactly when the first
 * agents need to be added.
 */
export async function createInvite(_state: AdminState, formData: FormData): Promise<AdminState> {
  const admin = await requirePermission('admin.agents');

  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const name = String(formData.get('name') ?? '').trim() || null;
  const role = String(formData.get('role') ?? 'agent');

  if (!email.includes('@')) return { error: 'Enter a valid email address' };
  if (!['agent', 'supervisor', 'admin', 'account_admin'].includes(role)) {
    return { error: 'Unknown role' };
  }

  const existing = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.email, email))
    .limit(1);
  if (existing.length > 0) return { error: 'That agent already exists' };

  const token = generateToken();

  // Supersede any open invite for the same address, so a resend does not leave
  // two working links with different roles.
  await db.delete(invites).where(and(eq(invites.email, email), isNull(invites.acceptedAt)));

  await db.insert(invites).values({
    tokenHash: hashToken(token),
    email,
    name,
    role: role as 'agent' | 'supervisor' | 'admin' | 'account_admin',
    invitedByAgentId: admin.id,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });

  revalidatePath('/admin/agents');

  return { error: null, inviteUrl: `${appUrl()}/invite/${token}` };
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
  const type = String(formData.get('type') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const defaultGroupId = String(formData.get('defaultGroupId') ?? '') || null;
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();
  const address = String(formData.get('address') ?? '').trim();
  const whatsappAccountId = String(formData.get('whatsappAccountId') ?? '') || null;

  if (!name) return { error: 'Give the channel a name' };
  if (!['email', 'whatsapp', 'webchat', 'facebook', 'instagram', 'whatsapp_bot'].includes(type)) {
    return { error: 'Unknown channel type' };
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
