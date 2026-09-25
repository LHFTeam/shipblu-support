import { and, asc, eq, exists, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { channels, whatsappAccounts, whatsappTemplates } from '@/db/schema';
import { env } from '@/lib/env';

/**
 * Which WhatsApp Business Account a number belongs to, and the token that talks
 * to it.
 *
 * Everything Meta scopes to a WABA has to be resolved through here: the token a
 * send authenticates with, the account a media id can be exchanged on, and the
 * set of templates an agent is allowed to pick from. Before this existed there
 * was one of each, named by `WHATSAPP_WABA_ID` and `META_PAGE_ACCESS_TOKEN`,
 * and connecting a second business account meant running a second copy of the
 * app.
 *
 * ## What one row does not cover
 *
 * A WABA under a *different Meta app* needs more than a row here. The app
 * secret (`META_APP_SECRET`) is what `app/api/webhooks/whatsapp` verifies
 * `X-Hub-Signature-256` with, and the verify token answers the subscription
 * handshake — both belong to the app, not to the business account, and both are
 * single-valued. Inbound from a WABA on another app would be stored unverified
 * and answered 403.
 *
 * That is deliberate rather than unfinished. The case this is built for is the
 * one people actually have: one Meta app installed on several WABAs in the same
 * Business Manager, one webhook, and either one system-user token for the lot
 * or a separate token per account. Making the app secret per-account would mean
 * trying every configured secret against every inbound signature, which turns a
 * comparison that either matches or is a forgery into a search — the sort of
 * thing that is easy to get subtly wrong and hard to notice.
 */

export type WhatsAppAccount = {
  id: string;
  name: string;
  wabaId: string;
  tokenEnvVar: string | null;
  isDefault: boolean;
  isActive: boolean;
};

/** Everything a Graph call needs, resolved. */
export type WhatsAppCredentials = {
  token: string;
  /** Null when the caller is addressing something other than a number. */
  phoneNumberId: string | null;
  wabaId: string | null;
  accountId: string | null;
};

/**
 * An account's token is named, not stored — and only a name matching this may
 * be named.
 *
 * The indirection is what keeps the credential out of the database. The prefix
 * is what stops it being an arbitrary read of the process's environment: the
 * value is sent to Meta as a bearer token, so an admin free to type any name
 * could put `DATABASE_URL` in the box and have it posted to graph.facebook.com.
 * They never see the value, which is precisely why the leak would be silent.
 */
const TOKEN_ENV_PREFIX = 'WHATSAPP_TOKEN_';
const TOKEN_ENV_PATTERN = /^WHATSAPP_TOKEN_[A-Z0-9][A-Z0-9_]*$/;

export type TokenEnvVarResult = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Normalises what an admin typed into the "token variable" box.
 *
 * Blank — and the shared variable typed out in full, which is the same thing
 * said the long way — become null, meaning `META_PAGE_ACCESS_TOKEN`. Anything
 * else must be a `WHATSAPP_TOKEN_*` name.
 */
export function parseTokenEnvVar(raw: string): TokenEnvVarResult {
  const name = raw.trim().toUpperCase();

  if (!name || name === 'META_PAGE_ACCESS_TOKEN') return { ok: true, value: null };

  if (!TOKEN_ENV_PATTERN.test(name)) {
    return {
      ok: false,
      error:
        `An access token variable must be named ${TOKEN_ENV_PREFIX}… (letters, ` +
        `digits and underscores), or left blank to use the shared ` +
        `META_PAGE_ACCESS_TOKEN.`,
    };
  }

  return { ok: true, value: name };
}

/**
 * The account a number belongs to, with the fallback order spelled out.
 *
 * Pure, and separate from the query that feeds it, because the order is the
 * part worth being sure about and it needs no database to check.
 *
 * A number linked to an account uses that account even when the account is
 * switched off. Falling through to the default instead would send the reply
 * from a business account the customer has never messaged, and Meta rejects
 * that — asynchronously, on a status webhook, long after the send API returned
 * a message id. "Nothing goes out" is a failure someone sees; "it went out from
 * the wrong WABA" is one nobody does.
 */
export function resolveAccount<T extends { id: string; isDefault: boolean; isActive: boolean }>(
  accounts: T[],
  linkedAccountId: string | null,
): T | null {
  if (linkedAccountId) {
    const linked = accounts.find((account) => account.id === linkedAccountId);
    if (linked) return linked;
  }

  return (
    accounts.find((account) => account.isDefault && account.isActive) ??
    accounts.find((account) => account.isActive) ??
    null
  );
}

/**
 * The access token for an account.
 *
 * `process.env` directly rather than `env()`: the variable's name is data, so
 * it cannot appear in the Zod schema, and `env()` parses the whole schema on
 * first call. Same reasoning as `lib/shipments/detect.ts`.
 */
export function tokenForAccount(account: Pick<WhatsAppAccount, 'tokenEnvVar'> | null): string {
  const name = account?.tokenEnvVar;

  if (!name) {
    const shared = env().META_PAGE_ACCESS_TOKEN;
    if (!shared) throw new Error('META_PAGE_ACCESS_TOKEN is not configured');
    return shared;
  }

  // Re-checked on read, not only on write: the row could predate the rule, or
  // have been edited straight in the database.
  const parsed = parseTokenEnvVar(name);
  if (!parsed.ok) throw new Error(`${name} is not a usable token variable. ${parsed.error}`);

  const value = parsed.value ? process.env[parsed.value] : env().META_PAGE_ACCESS_TOKEN;
  if (!value) {
    throw new Error(
      `${name} names the access token for this WhatsApp business account, but it is not set. ` +
        `Add it to the shipblu-support-production environment group.`,
    );
  }

  return value;
}

const ACCOUNT_COLUMNS = {
  id: whatsappAccounts.id,
  name: whatsappAccounts.name,
  wabaId: whatsappAccounts.wabaId,
  tokenEnvVar: whatsappAccounts.tokenEnvVar,
  isDefault: whatsappAccounts.isDefault,
  isActive: whatsappAccounts.isActive,
};

export async function listAccounts(): Promise<WhatsAppAccount[]> {
  return db.select(ACCOUNT_COLUMNS).from(whatsappAccounts).orderBy(asc(whatsappAccounts.name));
}

export async function listActiveAccounts(): Promise<WhatsAppAccount[]> {
  return db
    .select(ACCOUNT_COLUMNS)
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.isActive, true))
    .orderBy(asc(whatsappAccounts.name));
}

/**
 * The account a phone number id sends and receives on.
 *
 * The number is looked up in `channels` — the same table inbound routing
 * matches on — so a number the console knows about and a number the worker
 * sends from cannot disagree about which business account they belong to.
 * Null when nothing is configured at all, which is the pre-multi-WABA state and
 * resolves to the environment's credentials downstream.
 */
export async function accountForPhoneNumberId(
  phoneNumberId: string | null,
): Promise<WhatsAppAccount | null> {
  const [accounts, linkedAccountId] = await Promise.all([
    listAccounts(),
    phoneNumberId ? linkedAccountIdFor(phoneNumberId) : Promise.resolve(null),
  ]);

  return resolveAccount(accounts, linkedAccountId);
}

/** The account id on the channel row that owns this number, if there is one. */
async function linkedAccountIdFor(phoneNumberId: string): Promise<string | null> {
  const rows = await db
    .select({ whatsappAccountId: channels.whatsappAccountId, config: channels.config })
    .from(channels)
    .where(inArray(channels.type, ['whatsapp', 'whatsapp_bot']));

  const match = rows.find((row) => row.config?.phoneNumberId === phoneNumberId);
  return match?.whatsappAccountId ?? null;
}

/** Everything a send from `phoneNumberId` needs. */
export async function credentialsForPhoneNumberId(
  phoneNumberId: string | null,
): Promise<WhatsAppCredentials> {
  const account = await accountForPhoneNumberId(phoneNumberId);

  return {
    token: tokenForAccount(account),
    // The environment default is only ever reached by a send with no inbound
    // history and no channel row — see `credentials` in ./client.
    phoneNumberId: phoneNumberId ?? env().WHATSAPP_PHONE_NUMBER_ID ?? null,
    wabaId: account?.wabaId ?? env().WHATSAPP_WABA_ID ?? null,
    accountId: account?.id ?? null,
  };
}

export function credentialsForAccount(account: WhatsAppAccount): WhatsAppCredentials {
  return {
    token: tokenForAccount(account),
    phoneNumberId: null,
    wabaId: account.wabaId,
    accountId: account.id,
  };
}

/**
 * Turns the WABA named in the environment into a row, and keeps the rows that
 * predate multi-WABA pointed at it.
 *
 * Run from the template sync rather than from a migration, because a migration
 * cannot read `WHATSAPP_WABA_ID` — and run at all so that upgrading does not
 * require an admin to retype configuration the system already has. Without it,
 * the first hourly sync after this ships would find no accounts and do nothing,
 * and the console's template picker would be empty until somebody noticed.
 *
 * The adoption below runs on **every** call, not only on the one that inserts
 * the row. It used to be tied to the insert, on the reasoning that re-running it
 * would sweep up rows an admin had deliberately left unassigned — but there are
 * no such rows. `saveChannel` refuses a WhatsApp channel with no business
 * account as soon as one account exists, and a template is only ever written by
 * the sync, which always names one. So a null link means "configured before
 * there were accounts" and nothing else, whichever way the row got here.
 *
 * Tying it to the insert had a cost that was not obvious: the channels screen
 * invites an admin to connect `WHATSAPP_WABA_ID` by hand, and doing so took the
 * insert path away from this function. Every already-synced template then kept
 * its null account, `listApprovedTemplates` filters on an exact match, and the
 * agent's template picker was empty with no error anywhere to explain it.
 */
export async function ensureEnvironmentAccount(): Promise<WhatsAppAccount | null> {
  const wabaId = env().WHATSAPP_WABA_ID;
  if (!wabaId) return null;

  const account = (await accountForWabaId(wabaId)) ?? (await insertEnvironmentAccount(wabaId));
  if (!account) return null;

  // Best-effort, and never allowed to stop the sync. This runs ahead of the
  // sync's per-account try/catch, so anything it throws — a second worker's
  // copy landing between the delete and the adoption below is the one known
  // way — would otherwise fail every account for the hour and record no
  // `lastSyncError`. Whatever it misses, the next run picks up.
  try {
    await adoptUnassigned(account);
  } catch (error) {
    console.error(`[whatsapp] adopting unassigned rows for ${account.name} failed`, error);
  }

  return account;
}

async function accountForWabaId(wabaId: string): Promise<WhatsAppAccount | null> {
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.wabaId, wabaId))
    .limit(1);

  return rows[0] ?? null;
}

async function insertEnvironmentAccount(wabaId: string): Promise<WhatsAppAccount | null> {
  const existing = await db
    .select({ name: whatsappAccounts.name, isDefault: whatsappAccounts.isDefault })
    .from(whatsappAccounts);

  const inserted = await db
    .insert(whatsappAccounts)
    .values({
      name: freeName(new Set(existing.map((row) => row.name)), wabaId),
      wabaId,
      // Null, not the literal name: the row is describing "the shared token",
      // and writing the variable's name here would make a later rename of the
      // shared credential a database migration.
      tokenEnvVar: null,
      isDefault: !existing.some((row) => row.isDefault),
    })
    // Untargeted, because `waba_id` is not the only unique index on this table
    // and a second worker running the same cron must not race a duplicate in.
    // Naming only the `waba_id` target let a clash on `name` raise 23505 out of
    // the top of this function, which runs before the sync's per-account
    // try/catch — so one collision stopped every account from syncing, hourly,
    // and recorded no `lastSyncError` anywhere to say why.
    .onConflictDoNothing()
    .returning(ACCOUNT_COLUMNS);

  if (inserted[0]) {
    console.log(
      `[whatsapp] adopted WHATSAPP_WABA_ID ${wabaId} as business account ${inserted[0].id}`,
    );
    return inserted[0];
  }

  // Lost a race, or lost to the name index. The first has a row to return; the
  // second has to be said out loud, because nothing else in the system will
  // notice that the environment's WABA never became a row.
  const raced = await accountForWabaId(wabaId);
  if (!raced) {
    console.warn(
      `[whatsapp] could not adopt WHATSAPP_WABA_ID ${wabaId}: a business account with the ` +
        `same name already exists. Rename it under Settings → Channels, or connect this ` +
        `WABA there by hand.`,
    );
  }

  return raced;
}

/**
 * A name no other account holds.
 *
 * `whatsapp_accounts_name_idx` is unique, and 'WhatsApp' is the obvious thing to
 * call the first connection an admin makes by hand — so it is exactly the name
 * that is already taken by the time this runs. The WABA id disambiguates
 * without inventing a numbering scheme, and reads as what it is in the picker.
 */
function freeName(taken: Set<string>, wabaId: string): string {
  if (!taken.has('WhatsApp')) return 'WhatsApp';

  const withId = `WhatsApp ${wabaId}`;
  if (!taken.has(withId)) return withId;

  let n = 2;
  while (taken.has(`${withId} (${n})`)) n += 1;
  return `${withId} (${n})`;
}

/**
 * Point every row that predates multi-WABA at this account.
 *
 * Every write matches only `IS NULL`, so the second and every later call is a
 * no-op that touches nothing — which is what makes running this on every sync
 * cheap enough to be the simple thing to do.
 */
async function adoptUnassigned(account: WhatsAppAccount): Promise<void> {
  const channelRows = await db
    .update(channels)
    .set({ whatsappAccountId: account.id })
    .where(
      and(inArray(channels.type, ['whatsapp', 'whatsapp_bot']), isNull(channels.whatsappAccountId)),
    )
    .returning({ id: channels.id });

  // Adopted rather than left for the next sync to rewrite, so the console's
  // template picker does not go empty for an hour on the deploy that adds this.
  // The upsert cannot repair them on its own either: its conflict target is
  // (account, name, language), and a null account matches nothing, so a sync
  // would insert a second copy beside each orphan and leave the orphan
  // APPROVED for ever — `staleTemplateFilter` skips null accounts too.
  //
  // Which is also why the orphans that already have a copy are deleted first
  // rather than adopted. Running this on every sync means it now runs after
  // syncs that went ahead without it — the case it exists for: an admin
  // connected the WABA by hand, the hourly sync inserted a fresh copy of each
  // template under the account, and the orphans sat beside them. Adopting such
  // an orphan collides with its copy on `(account, name, language)`, and this
  // runs before the sync's per-account try/catch, so the 23505 would stop every
  // account syncing, hourly, with no `lastSyncError` to say why. The copy is
  // the one the sync has kept current; the orphan is what it replaced, and
  // nothing references a template row by id.
  const copy = alias(whatsappTemplates, 'copy');
  const superseded = await db
    .delete(whatsappTemplates)
    .where(
      and(
        isNull(whatsappTemplates.whatsappAccountId),
        exists(
          db
            .select({ id: copy.id })
            .from(copy)
            .where(
              and(
                eq(copy.whatsappAccountId, account.id),
                eq(copy.name, whatsappTemplates.name),
                eq(copy.language, whatsappTemplates.language),
              ),
            ),
        ),
      ),
    )
    .returning({ id: whatsappTemplates.id });

  const templateRows = await db
    .update(whatsappTemplates)
    .set({ whatsappAccountId: account.id })
    .where(isNull(whatsappTemplates.whatsappAccountId))
    .returning({ id: whatsappTemplates.id });

  if (channelRows.length || templateRows.length || superseded.length) {
    console.log(
      `[whatsapp] ${account.name} adopted ${channelRows.length} unassigned channel(s) and ` +
        `${templateRows.length} unassigned template(s), and removed ${superseded.length} ` +
        `unassigned template(s) the sync had already replaced`,
    );
  }
}
