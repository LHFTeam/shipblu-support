import { count, eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  type CredentialEventKind,
  whatsappAccountCredentials as credentials,
  whatsappAccounts,
  whatsappCredentialEvents as events,
} from '@/db/schema';
import { env } from '@/lib/env';
import type { TokenInspection } from '@/lib/meta/debug-token';
import {
  CredentialKeyError,
  type Keyring,
  keyStateOf,
  parseKeyring,
  seal,
  unseal,
} from './credential-envelope';
import type { CredentialStatus } from './credential-status';

/**
 * The stored WhatsApp credential: the only module that reads or writes
 * `whatsapp_account_credentials`.
 *
 * A business token minted by Embedded Signup is the one credential this
 * database holds (`db/schema/config.ts` says why), and the rules that make
 * holding it acceptable are kept here, in one place, rather than in every
 * caller's good intentions:
 *
 * - **The plaintext leaves this module through one export.** `storedTokenFor`
 *   opens an envelope and returns what it opened; `lib/whatsapp/accounts.ts` is
 *   the only module allowed to call it, and the resolvers there may be imported
 *   only by the worker. `resealStoredCredentials` opens envelopes too, returns
 *   none of them, and may be imported only by the rotation job. So no code path
 *   on the web service decrypts a stored token — the web service only ever
 *   seals one, on the way in. CI holds the imports (`credential-confinement`);
 *   what it cannot see is a new export of `accounts.ts` that calls a resolver on
 *   a page's behalf, and that is review's.
 * - **No read selects a whole row.** Every read names its columns, and only
 *   `storedTokenFor` and the reseal name `envelope` — CI refuses the empty
 *   `select()` and `returning()` that would carry it out unopened; naming it
 *   anywhere else is review's.
 * - **One source per account.** Storing a credential clears the account's
 *   token variable, and an account with a stored credential refuses a variable
 *   and a change of WABA id (`storedCredentialEditRefusal`): the envelope is
 *   bound to the WABA in its authenticated data, and two sources would make
 *   "which token sent this?" a question with two answers.
 * - **Everything that happens to one is a row.** Stored, resealed, refused,
 *   removed — `whatsapp_credential_events`, naming the agent, and surviving the
 *   account it was about.
 */

/** Who did it: a person, or null when a job did. */
export type CredentialActor = { id: string; label: string } | null;

/** Something queries can run on — the module's `db`, or a transaction. */
type Executor = typeof db;

/**
 * The two permissions a business token cannot reach a WABA without — reading
 * it, and sending from its numbers.
 */
export const REQUIRED_BUSINESS_TOKEN_SCOPES = [
  'whatsapp_business_management',
  'whatsapp_business_messaging',
] as const;

function keyring(): Keyring {
  const e = env();
  return parseKeyring(e.WHATSAPP_CREDENTIAL_KEY, e.WHATSAPP_CREDENTIAL_KEY_PREVIOUS);
}

/**
 * The keyring for a status read, which must not throw: an admin page that
 * fails because a key is misconfigured is a page that cannot say the key is
 * misconfigured. Unset is not a problem to describe — it is the state of every
 * deployment before the first number is connected.
 */
function keyringForStatus(): { keyring: Keyring | null; problem: string | null } {
  try {
    return { keyring: keyring(), problem: null };
  } catch (error) {
    if (!(error instanceof CredentialKeyError)) throw error;
    return { keyring: null, problem: error.reason === 'unset' ? null : error.message };
  }
}

async function appendEvent(
  executor: Executor,
  event: {
    accountId: string;
    wabaId: string;
    kind: CredentialEventKind;
    keyId: string | null;
    actor: CredentialActor;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await executor.insert(events).values({
    whatsappAccountId: event.accountId,
    wabaId: event.wabaId,
    event: event.kind,
    keyId: event.keyId,
    agentId: event.actor?.id ?? null,
    agentLabel: event.actor?.label ?? null,
    detail: event.detail ?? {},
  });
}

export type StoreBusinessTokenInput = {
  accountId: string;
  /** The WABA the token was proven against. Must be the account's own. */
  wabaId: string;
  token: string;
  /** What `debug_token` said, or null when it could not be asked. */
  inspection: TokenInspection | null;
  businessId: string | null;
  actor: CredentialActor;
};

/**
 * Seals and stores a business token for an account, replacing any it had.
 *
 * Takes the transaction it runs in, so the caller can commit the account row,
 * the credential and whatever it is about to enqueue as one thing. Locks the
 * account row first, which is also what serialises this against an admin's save
 * of the same row (`storedCredentialEditRefusal` takes the same lock).
 *
 * Clears the account's token variable: one source per account. The variable it
 * replaced is written into the `stored` event, which is the only record of what
 * the account used to send with.
 */
export async function storeBusinessToken(
  tx: Executor,
  input: StoreBusinessTokenInput,
): Promise<{ keyId: string; previousKeyId: string | null; replacedVariable: string | null }> {
  const [account] = await tx
    .select({ wabaId: whatsappAccounts.wabaId, tokenEnvVar: whatsappAccounts.tokenEnvVar })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.id, input.accountId))
    .for('update');

  if (!account) throw new Error(`business account ${input.accountId} no longer exists`);

  // The envelope is bound to the WABA in its authenticated data. A caller
  // storing a token proven against one WABA onto a row for another would write
  // a credential that opens — and sends — on behalf of the wrong business.
  if (account.wabaId !== input.wabaId) {
    throw new Error(
      `refusing to store a credential proven against WABA ${input.wabaId} on the row for ` +
        `WABA ${account.wabaId}`,
    );
  }

  // Before anything is written: a missing or malformed key must fail the store,
  // not leave a row behind that nothing can open.
  const ring = keyring();
  const envelope = seal(input.token, ring, { accountId: input.accountId, wabaId: input.wabaId });
  const keyId = ring.current.id;

  const [previous] = await tx
    .select({ keyId: credentials.keyId })
    .from(credentials)
    .where(eq(credentials.whatsappAccountId, input.accountId))
    .for('update');

  const now = new Date();
  const inspection = input.inspection;
  const values = {
    envelope,
    keyId,
    source: 'embedded_signup',
    tokenType: inspection?.type ?? null,
    appId: inspection?.appId ?? null,
    scopes: inspection?.scopes ?? null,
    businessId: input.businessId,
    issuedAt: inspection?.issuedAt ?? null,
    expiresAt: inspection?.expiresAt ?? null,
    dataAccessExpiresAt: inspection?.dataAccessExpiresAt ?? null,
    inspectedAt: inspection ? now : null,
    obtainedByAgentId: input.actor?.id ?? null,
    storedAt: now,
    // A new token has not been accepted or refused by anybody yet. Carrying
    // the old one's refusal over would badge a fresh reconnect as broken.
    lastVerifiedAt: null,
    lastRefusedAt: null,
    lastRefusal: null,
  };

  await tx
    .insert(credentials)
    .values({ whatsappAccountId: input.accountId, ...values })
    .onConflictDoUpdate({ target: credentials.whatsappAccountId, set: values });

  if (account.tokenEnvVar) {
    await tx
      .update(whatsappAccounts)
      .set({ tokenEnvVar: null, updatedAt: now })
      .where(eq(whatsappAccounts.id, input.accountId));
  }

  await appendEvent(tx, {
    accountId: input.accountId,
    wabaId: input.wabaId,
    kind: 'stored',
    keyId,
    actor: input.actor,
    detail: {
      source: 'embedded_signup',
      previousKeyId: previous?.keyId ?? null,
      replacedVariable: account.tokenEnvVar,
      inspected: inspection !== null,
      tokenType: inspection?.type ?? null,
      scopes: inspection?.scopes ?? null,
      expiresAt: inspection ? (inspection.expiresAt?.toISOString() ?? 'never') : null,
      businessId: input.businessId,
    },
  });

  return { keyId, previousKeyId: previous?.keyId ?? null, replacedVariable: account.tokenEnvVar };
}

/**
 * The stored token for an account, opened — or null when none is stored.
 *
 * **The only export that returns a plaintext token**, and
 * `lib/whatsapp/accounts.ts` the only module that may call it (CI). Throws `CredentialKeyError` when the envelope
 * cannot be opened rather than answering null: null means "there is no stored
 * credential", and a caller that heard it would fall back to another token.
 *
 * The binding is the account's *current* WABA id, read by the caller from the
 * row. An envelope left on a row whose WABA id was changed in SQL therefore
 * fails authentication — which is the point of binding it.
 */
export async function storedTokenFor(account: {
  id: string;
  wabaId: string;
}): Promise<string | null> {
  const [row] = await db
    .select({ envelope: credentials.envelope })
    .from(credentials)
    .where(eq(credentials.whatsappAccountId, account.id))
    .limit(1);

  if (!row) return null;
  return unseal(row.envelope, keyring(), { accountId: account.id, wabaId: account.wabaId });
}

/**
 * Whether an account has a stored credential, as a column for a select over
 * `whatsapp_accounts` — so `lib/whatsapp/accounts.ts` can answer it in the same
 * query that lists the accounts, without naming this table itself.
 *
 * Both sides of the correlation are qualified by hand, `${table}.column`. In a
 * select-clause subquery drizzle renders `${table.column}` as a bare name, and
 * Postgres resolves a bare name against the innermost table first — the trap
 * `listGroupsForAdmin` in `lib/admin/settings.ts` fell into, where every group
 * counted zero tickets. Here the bare `id` would happen to reach the outer row
 * only because this table has no `id` of its own; the day it gets one, every
 * account would read as having no credential and send with the shared token.
 */
export function storedCredentialExists() {
  return sql<boolean>`exists (select 1 from ${credentials} where ${credentials}.whatsapp_account_id = ${whatsappAccounts}.id)`;
}

/**
 * Whether an account has a stored credential, read in a statement of its own.
 *
 * For a caller that has just locked the account row. Under READ COMMITTED a
 * statement's snapshot is taken before it waits for a lock, so an `exists()`
 * read in the same statement as the `for update` sees the table as it was
 * before the lock holder committed — a credential stored while this waited
 * would read as absent. A second statement takes a fresh snapshot after the
 * lock is granted, and sees it.
 */
async function lockedAccountHasCredential(tx: Executor, accountId: string): Promise<boolean> {
  const [row] = await tx
    .select({ keyId: credentials.keyId })
    .from(credentials)
    .where(eq(credentials.whatsappAccountId, accountId))
    .limit(1);
  return row !== undefined;
}

/**
 * Why an admin's edit of an account would break its stored credential, or null
 * when it would not.
 *
 * Two edits are refused while a credential is stored. Naming a token variable,
 * because one source per account is what lets every screen and log say which
 * token sent a message. And changing the WABA id, because the envelope is bound
 * to it: the credential would stop opening, every send would fail with a
 * sentence about authentication, and the cure would be the same "forget it
 * first" this sentence says now.
 *
 * Locks the account row — the lock `storeBusinessToken` takes too — and only
 * then asks whether a credential exists, in a separate statement
 * (`lockedAccountHasCredential` says why it must be separate). So a credential
 * stored by a concurrent connection is either seen here, or stored after the
 * caller's update has committed and found the row as the update left it.
 */
export async function storedCredentialEditRefusal(
  tx: Executor,
  accountId: string,
  change: { wabaId: string; tokenEnvVar: string | null },
): Promise<string | null> {
  const [row] = await tx
    .select({ wabaId: whatsappAccounts.wabaId })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.id, accountId))
    .for('update');

  if (!row || !(await lockedAccountHasCredential(tx, accountId))) return null;

  if (change.tokenEnvVar) {
    return (
      'This business account sends with the credential stored when it was connected ' +
      'through Meta, so it cannot also name a token variable. Forget the stored ' +
      'credential first.'
    );
  }

  if (change.wabaId !== row.wabaId) {
    return (
      `The stored credential belongs to business account ${row.wabaId} and cannot be ` +
      `moved to another. Forget the stored credential first, or connect the other ` +
      `business account as a new row.`
    );
  }

  return null;
}

/**
 * Every stored credential's status, by account — everything except the
 * credential.
 *
 * A named column list with `envelope` left out, which is the whole point of
 * this function: the admin page renders what it is handed.
 */
export async function credentialStatuses(
  executor: Executor = db,
): Promise<Map<string, CredentialStatus>> {
  const rows = await executor
    .select({
      accountId: credentials.whatsappAccountId,
      keyId: credentials.keyId,
      source: credentials.source,
      tokenType: credentials.tokenType,
      scopes: credentials.scopes,
      businessId: credentials.businessId,
      issuedAt: credentials.issuedAt,
      expiresAt: credentials.expiresAt,
      dataAccessExpiresAt: credentials.dataAccessExpiresAt,
      inspectedAt: credentials.inspectedAt,
      obtainedByAgentId: credentials.obtainedByAgentId,
      storedAt: credentials.storedAt,
      lastVerifiedAt: credentials.lastVerifiedAt,
      lastRefusedAt: credentials.lastRefusedAt,
      lastRefusal: credentials.lastRefusal,
    })
    .from(credentials);

  const { keyring: ring, problem } = keyringForStatus();

  return new Map(
    rows.map((row) => [
      row.accountId,
      { ...row, keyState: keyStateOf(row.keyId, ring), keyProblem: problem },
    ]),
  );
}

/**
 * Meta refused the stored credential (190): record Meta's sentence on the row,
 * and an event once per refusal rather than once per hourly sync.
 *
 * "Once per refusal" is a transition: the row was not already refused. A
 * success in between (`recordCredentialVerified`) clears the refusal, so the
 * next one is a new event.
 */
export async function recordCredentialRefusal(accountId: string, sentence: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        keyId: credentials.keyId,
        lastRefusedAt: credentials.lastRefusedAt,
        wabaId: whatsappAccounts.wabaId,
      })
      .from(credentials)
      .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, credentials.whatsappAccountId))
      .where(eq(credentials.whatsappAccountId, accountId))
      .for('update', { of: credentials });

    if (!row) return;

    const refusal = sentence.slice(0, 500);
    await tx
      .update(credentials)
      .set({ lastRefusedAt: new Date(), lastRefusal: refusal, updatedAt: new Date() })
      .where(eq(credentials.whatsappAccountId, accountId));

    if (row.lastRefusedAt === null) {
      await appendEvent(tx, {
        accountId,
        wabaId: row.wabaId,
        kind: 'refused',
        keyId: row.keyId,
        actor: null,
        detail: { refusal },
      });
    }
  });
}

/** Meta accepted the stored credential: the refusal, if any, is over. */
export async function recordCredentialVerified(accountId: string): Promise<void> {
  const now = new Date();
  await db
    .update(credentials)
    .set({ lastVerifiedAt: now, lastRefusedAt: null, lastRefusal: null, updatedAt: now })
    .where(eq(credentials.whatsappAccountId, accountId));
}

/**
 * Deletes an account's stored credential inside the caller's transaction, and
 * records who did it. False when there was none.
 *
 * Separate from `forgetStoredCredential` so disconnecting the whole account can
 * write the `removed` event in the transaction that deletes the account: the
 * cascade would take the credential either way, and only this says who. So it
 * must run **before** the account row is deleted — afterwards the cascade has
 * already taken the credential, and nothing is recorded.
 *
 * Locks the account row first, as `storeBusinessToken` does, and looks for the
 * credential in a later statement, so a credential stored while this waited is
 * the one removed and recorded rather than one the caller's delete cascades
 * away in silence.
 *
 * Deliberately nothing at Meta. Unsubscribing the app from the WABA would
 * silence the number's inbound tickets as a side effect of a decision about a
 * credential; revoking the token is done by the business, in Business Settings
 * → Integrations → Connected apps, or by offboarding on the phone.
 */
export async function removeStoredCredential(
  tx: Executor,
  accountId: string,
  actor: CredentialActor,
): Promise<boolean> {
  const [account] = await tx
    .select({ wabaId: whatsappAccounts.wabaId })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.id, accountId))
    .for('update');

  // No account, no credential: the foreign key cascades.
  if (!account) return false;

  const [removed] = await tx
    .delete(credentials)
    .where(eq(credentials.whatsappAccountId, accountId))
    .returning({ keyId: credentials.keyId });

  if (!removed) return false;

  await appendEvent(tx, {
    accountId,
    wabaId: account.wabaId,
    kind: 'removed',
    keyId: removed.keyId,
    actor,
  });

  return true;
}

/** Forgets an account's stored credential, leaving the account and its numbers. */
export async function forgetStoredCredential(
  accountId: string,
  actor: CredentialActor,
): Promise<boolean> {
  return db.transaction((tx) => removeStoredCredential(tx, accountId, actor));
}

export type ResealSummary = {
  /** Rows sealed under a key other than the current one. */
  examined: number;
  /** Moved to the current key — or, on a dry run, proven to open with the keyring. */
  resealed: number;
  failed: { accountId: string; reason: string }[];
};

/**
 * Moves every credential sealed under an older key onto the current one.
 *
 * The rotation: set `WHATSAPP_CREDENTIAL_KEY_PREVIOUS` to the old key and
 * `WHATSAPP_CREDENTIAL_KEY` to the new, run this, then unset the previous one.
 * One transaction per row, each with a `resealed` event, so a row that cannot
 * be opened — sealed under a key that is neither of the two — fails alone and
 * is named, and every other row still moves.
 *
 * A dry run opens every row it would move and writes nothing, which is what
 * makes it worth running first: it proves the previous key is the right one.
 *
 * With no key configured there is nothing it could do, and that is only a
 * problem if something is stored: an empty table skips (which is every
 * environment before the first number is connected), a non-empty one throws.
 */
export async function resealStoredCredentials(options: {
  dryRun: boolean;
}): Promise<ResealSummary | null> {
  let ring: Keyring;
  try {
    ring = keyring();
  } catch (error) {
    if (!(error instanceof CredentialKeyError) || error.reason !== 'unset') throw error;
    const [stored] = await db.select({ n: count() }).from(credentials);
    if (!stored?.n) return null;
    throw error;
  }

  const stale = await db
    .select({ accountId: credentials.whatsappAccountId })
    .from(credentials)
    .where(ne(credentials.keyId, ring.current.id));

  const summary: ResealSummary = { examined: stale.length, resealed: 0, failed: [] };

  for (const { accountId } of stale) {
    try {
      const moved = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            envelope: credentials.envelope,
            keyId: credentials.keyId,
            wabaId: whatsappAccounts.wabaId,
          })
          .from(credentials)
          .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, credentials.whatsappAccountId))
          .where(eq(credentials.whatsappAccountId, accountId))
          .for('update', { of: credentials });

        // Forgotten, or resealed by a concurrent run, since the list was read.
        if (!row || row.keyId === ring.current.id) return false;

        const binding = { accountId, wabaId: row.wabaId };
        const reopened = unseal(row.envelope, ring, binding);
        if (options.dryRun) return true;

        await tx
          .update(credentials)
          .set({
            envelope: seal(reopened, ring, binding),
            keyId: ring.current.id,
            updatedAt: new Date(),
          })
          .where(eq(credentials.whatsappAccountId, accountId));

        await appendEvent(tx, {
          accountId,
          wabaId: row.wabaId,
          kind: 'resealed',
          keyId: ring.current.id,
          actor: null,
          detail: { fromKeyId: row.keyId },
        });
        return true;
      });
      if (moved) summary.resealed += 1;
    } catch (error) {
      if (!(error instanceof CredentialKeyError)) throw error;
      summary.failed.push({ accountId, reason: error.message });
    }
  }

  return summary;
}
