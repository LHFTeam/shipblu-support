import { and, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { whatsappAccounts, whatsappTemplates } from '@/db/schema';
import { env } from '@/lib/env';
import {
  credentialsForAccount,
  ensureEnvironmentAccount,
  listActiveAccounts,
  type WhatsAppAccount,
} from '@/lib/whatsapp/accounts';
import { listTemplates, WhatsAppApiError } from '@/lib/whatsapp/client';
import { explainAuthError } from '@/lib/whatsapp/errors';
import { errorMessage } from '@/lib/errors';

/**
 * Rows this run did not refresh: templates deleted in Meta stop being returned.
 * Marking rather than deleting keeps the name resolvable for messages already
 * sent with it.
 *
 * Scoped to the account that was just synced. Without that, syncing the second
 * business account would mark every template of the first as deleted, because
 * the first account's rows were not refreshed by *this* call — a whole-table
 * filter and a per-account sync cannot both be right.
 *
 * Built from typed operators rather than a `sql` template on purpose, and
 * exported so a test can assert that. A bare Date interpolated into a template
 * arrives as an untyped parameter and postgres.js cannot serialise one — it
 * assumes text and throws ERR_INVALID_ARG_TYPE on the Date. Drizzle only maps a
 * Date when it knows the column it is being compared against, which is what
 * `lt` supplies and a raw template cannot.
 *
 * This cost a day of red crons. The failure is invisible without a real
 * database, and it sat here unreachable for weeks because an expired token was
 * failing the run earlier, at `listTemplates`. `lib/reports/live.ts` hit the
 * same wall and worked around it with an explicit `::timestamptz` cast; here no
 * raw SQL is needed at all.
 */
export function staleTemplateFilter(now: Date, accountId: string | null) {
  return and(
    lt(whatsappTemplates.syncedAt, now),
    ne(whatsappTemplates.status, 'DELETED'),
    accountId
      ? eq(whatsappTemplates.whatsappAccountId, accountId)
      : isNull(whatsappTemplates.whatsappAccountId),
  );
}

/**
 * Hourly sync of every connected WABA's approved templates.
 *
 * Templates are edited and approved in Meta's Business Manager, not here, so
 * the console's list would otherwise drift — an agent picking a template Meta
 * has since rejected gets an opaque send failure. Upsert on (account, name,
 * language) because that triple, not Meta's id, is what a send actually
 * references: two business accounts can both have `shipment_update`, with
 * different text and different approval states.
 */
export async function syncWhatsAppTemplates(): Promise<void> {
  // Turns a pre-multi-WABA environment into a row on the first run, so an
  // upgrade needs no admin retyping what the environment already says.
  await ensureEnvironmentAccount();

  const accounts = await listActiveAccounts();

  // The cron runs hourly from the moment the Blueprint creates it, which is
  // before anyone has pasted the Meta credentials in. Skipping quietly beats
  // failing every hour: a cron that is always red is a cron nobody reads, and
  // then the first real failure goes unnoticed.
  if (accounts.length === 0) {
    console.log(
      '[sync_whatsapp_templates] no WhatsApp business account is connected yet ' +
        '(Settings → Channels, or WHATSAPP_WABA_ID) — skipping',
    );
    return;
  }

  // `every`, not `some`: the quiet skip is for the install where nothing is
  // configured yet, and that is the case where *no* account has a token to sync
  // with. One account naming its own WHATSAPP_TOKEN_… is a working account, and
  // skipping the run on its behalf stopped it syncing because a different WABA
  // was waiting on a shared token — with no lastSyncError recorded anywhere,
  // so the admin screen showed both as merely "never synced". Below, the loop
  // fails that one account by itself and `tokenForAccount` names the variable.
  if (!env().META_PAGE_ACCESS_TOKEN && accounts.every((account) => !account.tokenEnvVar)) {
    console.log(
      '[sync_whatsapp_templates] META_PAGE_ACCESS_TOKEN is not set and every account ' +
        'relies on it — skipping',
    );
    return;
  }

  // One account's failure must not cost the others their sync: an expired token
  // on a secondary WABA would otherwise silently stop refreshing the main one's
  // templates. Collected and rethrown at the end so the cron still goes red.
  const failures: string[] = [];

  for (const account of accounts) {
    try {
      await syncAccount(account);
    } catch (error) {
      const reason = errorMessage(error);
      const explained =
        error instanceof WhatsAppApiError ? explainAuthError(error.code, error.message) : reason;

      console.error(`[sync_whatsapp_templates] ${account.name}: ${explained}`);
      await recordSync(account.id, explained);
      failures.push(`${account.name}: ${reason}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${accounts.length} WhatsApp business account(s) failed to ` +
        `sync — ${failures.join('; ')}`,
    );
  }
}

async function syncAccount(account: WhatsAppAccount): Promise<void> {
  const { token, wabaId } = credentialsForAccount(account);
  const templates = await listTemplates({ wabaId, token });

  if (templates.length === 0) {
    // Deliberately not treated as "delete everything": an API hiccup returning
    // an empty page must not wipe the templates agents are relying on.
    //
    // The WABA id is in the line because this is the one outcome that is not
    // self-explanatory. Graph answers 200 with an empty list for a WABA that
    // genuinely holds no templates *and* for an id that is not a WABA at all —
    // so a mistyped id syncs "successfully" every hour for ever, and the id is
    // the only thing in the message worth checking.
    console.warn(
      `[sync_whatsapp_templates] ${account.name} (${account.wabaId}) returned no templates, ` +
        `leaving existing rows`,
    );
    await recordSync(account.id, null);
    return;
  }

  const now = new Date();

  for (const template of templates) {
    await db
      .insert(whatsappTemplates)
      .values({
        whatsappAccountId: account.id,
        metaTemplateId: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
        components: template.components ?? [],
        status: template.status,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          whatsappTemplates.whatsappAccountId,
          whatsappTemplates.name,
          whatsappTemplates.language,
        ],
        set: {
          metaTemplateId: sql`excluded.meta_template_id`,
          category: sql`excluded.category`,
          components: sql`excluded.components`,
          status: sql`excluded.status`,
          syncedAt: now,
        },
      });
  }

  const stale = await db
    .update(whatsappTemplates)
    .set({ status: 'DELETED' })
    .where(staleTemplateFilter(now, account.id))
    .returning({ id: whatsappTemplates.id });

  await recordSync(account.id, null);

  console.log(
    `[sync_whatsapp_templates] ${account.name}: synced ${templates.length}` +
      (stale.length ? `, marked ${stale.length} deleted` : ''),
  );
}

/**
 * The outcome, on the account row.
 *
 * So the admin screen can say which connection is actually working. A WABA
 * whose token cannot read it looks identical to a healthy one everywhere else,
 * and the difference only surfaces when an agent's template send fails.
 */
async function recordSync(accountId: string, error: string | null): Promise<void> {
  await db
    .update(whatsappAccounts)
    .set({
      // Only on success: keeping the last good sync time visible is what makes
      // "connected, but stale since Tuesday" readable at a glance.
      ...(error ? {} : { lastSyncedAt: new Date() }),
      lastSyncError: error?.slice(0, 500) ?? null,
      updatedAt: new Date(),
    })
    .where(eq(whatsappAccounts.id, accountId));
}
