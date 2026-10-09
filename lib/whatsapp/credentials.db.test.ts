import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  whatsappAccountCredentials,
  whatsappAccounts,
  whatsappCredentialEvents,
} from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import type { TokenInspection } from '@/lib/meta/debug-token';
import { withCleanDatabase } from '@/lib/testing/db';
import { listAccounts, tokenForAccount } from './accounts';
import { CredentialKeyError, parseKeyring } from './credential-envelope';
import {
  credentialStatuses,
  forgetStoredCredential,
  recordCredentialRefusal,
  recordCredentialVerified,
  removeStoredCredential,
  resealStoredCredentials,
  storeBusinessToken,
  storedCredentialEditRefusal,
  storedTokenFor,
} from './credentials';

/**
 * The stored credential against a real database: what lands in the row, which
 * token a send resolves to, and what an admin's edit, a disconnect and a key
 * rotation do to it. The properties are the ones `credentials.ts` lists — one
 * source per account, no envelope out unopened, an audit row for everything —
 * and each is only true if the SQL behind it is.
 */

withCleanDatabase();

const KEY_A = 'a'.repeat(20) + 'db-test-key-a-0123456789';
const KEY_B = 'b'.repeat(20) + 'db-test-key-b-0123456789';
const KEY_C = 'c'.repeat(20) + 'db-test-key-c-0123456789';
const TOKEN = 'EAAGm0PX4ZCpsBAEXAMPLEstoredTokenValue123456';

const INSPECTION: TokenInspection = {
  type: 'SYSTEM_USER',
  appId: '123',
  isValid: true,
  issuedAt: new Date('2026-10-01T00:00:00Z'),
  expiresAt: null,
  dataAccessExpiresAt: null,
  scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  granularScopes: [],
  error: null,
};

const saved = { ...process.env };

/** Points the process at a keyring, as the environment group would. */
function useKeys(current: string | undefined, previous?: string): void {
  process.env.WHATSAPP_CREDENTIAL_KEY = current;
  if (current === undefined) delete process.env.WHATSAPP_CREDENTIAL_KEY;
  if (previous === undefined) delete process.env.WHATSAPP_CREDENTIAL_KEY_PREVIOUS;
  else process.env.WHATSAPP_CREDENTIAL_KEY_PREVIOUS = previous;
  resetEnvCache();
}

beforeEach(() => {
  process.env.META_PAGE_ACCESS_TOKEN = 'shared-token';
  process.env.WHATSAPP_TOKEN_DBTEST = 'variable-token';
  useKeys(KEY_A);
});

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

async function account(name: string, wabaId: string, tokenEnvVar: string | null = null) {
  const [row] = await db
    .insert(whatsappAccounts)
    .values({ name, wabaId, tokenEnvVar })
    .returning({ id: whatsappAccounts.id, wabaId: whatsappAccounts.wabaId });
  return row!;
}

async function admin() {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Mona Admin', email: 'mona@shipblu.test', role: 'admin' })
    .returning({ id: agents.id, name: agents.name });
  return { id: row!.id, label: row!.name };
}

async function store(
  target: { id: string; wabaId: string },
  actor = null as Awaited<ReturnType<typeof admin>> | null,
) {
  return db.transaction((tx) =>
    storeBusinessToken(tx, {
      accountId: target.id,
      wabaId: target.wabaId,
      token: TOKEN,
      inspection: INSPECTION,
      businessId: '555',
      actor,
    }),
  );
}

async function eventsFor(accountId: string) {
  return db
    .select({
      event: whatsappCredentialEvents.event,
      keyId: whatsappCredentialEvents.keyId,
      agentLabel: whatsappCredentialEvents.agentLabel,
      detail: whatsappCredentialEvents.detail,
    })
    .from(whatsappCredentialEvents)
    .where(eq(whatsappCredentialEvents.whatsappAccountId, accountId))
    .orderBy(whatsappCredentialEvents.createdAt);
}

async function envelopeOf(accountId: string) {
  const [row] = await db
    .select({
      envelope: whatsappAccountCredentials.envelope,
      keyId: whatsappAccountCredentials.keyId,
    })
    .from(whatsappAccountCredentials)
    .where(eq(whatsappAccountCredentials.whatsappAccountId, accountId));
  return row ?? null;
}

describe('storing a business token', () => {
  it('writes ciphertext only, and records who stored it', async () => {
    const egypt = await account('Egypt', '111111');
    const mona = await admin();

    const { keyId } = await store(egypt, mona);

    const row = await envelopeOf(egypt.id);
    expect(row!.envelope).not.toContain(TOKEN);
    expect(row!.keyId).toBe(keyId);
    expect(keyId).toBe(parseKeyring(KEY_A, undefined).current.id);
    expect(await storedTokenFor(egypt)).toBe(TOKEN);

    expect(await eventsFor(egypt.id)).toEqual([
      expect.objectContaining({ event: 'stored', keyId, agentLabel: 'Mona Admin' }),
    ]);
  });

  it('hands the console a status with no envelope in it', async () => {
    const egypt = await account('Egypt', '111111');
    await store(egypt);

    const status = (await credentialStatuses()).get(egypt.id)!;

    expect(Object.keys(status)).not.toContain('envelope');
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(status).toMatchObject({
      keyState: 'current',
      keyProblem: null,
      source: 'embedded_signup',
      tokenType: 'SYSTEM_USER',
      expiresAt: null,
      businessId: '555',
    });
    expect(status.inspectedAt).toBeInstanceOf(Date);
  });

  /** One source per account. The variable it replaced is kept on the audit row. */
  it('clears the token variable it replaces, and remembers which one it was', async () => {
    const egypt = await account('Egypt', '111111', 'WHATSAPP_TOKEN_DBTEST');

    await store(egypt);

    const [row] = await db
      .select({ tokenEnvVar: whatsappAccounts.tokenEnvVar })
      .from(whatsappAccounts)
      .where(eq(whatsappAccounts.id, egypt.id));
    expect(row!.tokenEnvVar).toBeNull();
    expect((await eventsFor(egypt.id))[0]!.detail).toMatchObject({
      replacedVariable: 'WHATSAPP_TOKEN_DBTEST',
    });
  });

  it('replaces a stored token in place, naming the key it replaced', async () => {
    const egypt = await account('Egypt', '111111');
    const first = await store(egypt);
    useKeys(KEY_B);

    const second = await store(egypt);

    expect(second.previousKeyId).toBe(first.keyId);
    expect((await envelopeOf(egypt.id))!.keyId).toBe(second.keyId);
    expect(await eventsFor(egypt.id)).toHaveLength(2);
  });

  it('refuses a token proven against another WABA, and writes nothing', async () => {
    const egypt = await account('Egypt', '111111');

    await expect(
      db.transaction((tx) =>
        storeBusinessToken(tx, {
          accountId: egypt.id,
          wabaId: '999999',
          token: TOKEN,
          inspection: null,
          businessId: null,
          actor: null,
        }),
      ),
    ).rejects.toThrow(/proven against WABA 999999/);

    expect(await envelopeOf(egypt.id)).toBeNull();
    expect(await eventsFor(egypt.id)).toEqual([]);
  });

  it('refuses to store without a key, and leaves no row nothing could open', async () => {
    const egypt = await account('Egypt', '111111', 'WHATSAPP_TOKEN_DBTEST');
    useKeys(undefined);

    await expect(store(egypt)).rejects.toThrow(CredentialKeyError);

    expect(await envelopeOf(egypt.id)).toBeNull();
    const [row] = await db
      .select({ tokenEnvVar: whatsappAccounts.tokenEnvVar })
      .from(whatsappAccounts)
      .where(eq(whatsappAccounts.id, egypt.id));
    expect(row!.tokenEnvVar).toBe('WHATSAPP_TOKEN_DBTEST');
  });

  /**
   * Drizzle's own error quotes the statement and its parameters, and this
   * one's parameters hold the envelope. Forced here with an agent that does
   * not exist, which the foreign key refuses.
   */
  it('fails with Postgres’s sentence, never the statement or the envelope in it', async () => {
    const egypt = await account('Egypt', '111111');
    const ghost = { id: '00000000-0000-4000-8000-000000000000', label: 'Nobody' };

    const failure = await store(egypt, ghost).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toMatch(/^storing the credential failed \(23503\): /);
    expect(failure?.message).not.toMatch(/v1\.|params|insert into/i);
    expect(failure && 'cause' in failure).toBe(false);
    expect(await envelopeOf(egypt.id)).toBeNull();
  });
});

describe('which token a send resolves to', () => {
  /**
   * The correlation in `storedCredentialExists`: two accounts, one credential,
   * and only its own account may read as holding it. Today the unqualified
   * spelling would pass this too — the table has no `id` of its own for a bare
   * name to find — so this is what fails, in the PR that gives it one, if the
   * hand-written qualification is ever "tidied" back into `${table.column}`.
   */
  it('says which accounts hold a stored credential, and only those', async () => {
    const egypt = await account('Egypt', '111111');
    await account('Saudi', '222222');
    await store(egypt);

    const listed = await listAccounts();

    expect(listed.map((row) => [row.name, row.hasStoredToken])).toEqual([
      ['Egypt', true],
      ['Saudi', false],
    ]);
  });

  it('goes stored, then variable, then shared — end to end', async () => {
    const egypt = await account('Egypt', '111111', 'WHATSAPP_TOKEN_DBTEST');
    const saudi = await account('Saudi', '222222');
    const byId = async (id: string) => (await listAccounts()).find((row) => row.id === id)!;

    expect(await tokenForAccount(await byId(egypt.id))).toEqual({
      token: 'variable-token',
      source: 'variable',
    });
    expect(await tokenForAccount(await byId(saudi.id))).toEqual({
      token: 'shared-token',
      source: 'shared',
    });

    await store(egypt);

    expect(await tokenForAccount(await byId(egypt.id))).toEqual({ token: TOKEN, source: 'stored' });
  });

  it('falls back to the shared token once a credential is forgotten', async () => {
    const egypt = await account('Egypt', '111111');
    await store(egypt);

    expect(await forgetStoredCredential(egypt.id, null)).toBe(true);
    expect(await forgetStoredCredential(egypt.id, null)).toBe(false);

    const listed = (await listAccounts())[0]!;
    expect(listed.hasStoredToken).toBe(false);
    expect(await tokenForAccount(listed)).toEqual({ token: 'shared-token', source: 'shared' });
    expect((await eventsFor(egypt.id)).map((event) => event.event)).toEqual(['stored', 'removed']);
  });

  /**
   * An envelope that cannot be opened — the key changed under it, or the row's
   * WABA id was edited in SQL — stops the send and leaves the row alone.
   */
  it('throws on a key it does not hold, and on a WABA id changed under it', async () => {
    const egypt = await account('Egypt', '111111');
    await store(egypt);
    const before = await envelopeOf(egypt.id);

    useKeys(KEY_C);
    await expect(tokenForAccount({ ...egypt, tokenEnvVar: null })).rejects.toMatchObject({
      reason: 'unknown_key',
    });

    useKeys(KEY_A);
    await db
      .update(whatsappAccounts)
      .set({ wabaId: '333333' })
      .where(eq(whatsappAccounts.id, egypt.id));
    await expect(
      tokenForAccount({ id: egypt.id, wabaId: '333333', tokenEnvVar: null }),
    ).rejects.toMatchObject({ reason: 'undecryptable' });

    expect(await envelopeOf(egypt.id)).toEqual(before);
  });
});

describe("an admin's edit of an account with a stored credential", () => {
  it('refuses a token variable and a new WABA id, and allows everything else', async () => {
    const egypt = await account('Egypt', '111111');
    const plain = await account('Saudi', '222222');
    await store(egypt);

    const refusal = (id: string, change: { wabaId: string; tokenEnvVar: string | null }) =>
      db.transaction((tx) => storedCredentialEditRefusal(tx, id, change));

    expect(
      await refusal(egypt.id, { wabaId: '111111', tokenEnvVar: 'WHATSAPP_TOKEN_DBTEST' }),
    ).toMatch(/cannot also name a token variable/);
    expect(await refusal(egypt.id, { wabaId: '444444', tokenEnvVar: null })).toMatch(
      /belongs to business account 111111/,
    );
    expect(await refusal(egypt.id, { wabaId: '111111', tokenEnvVar: null })).toBeNull();
    expect(
      await refusal(plain.id, { wabaId: '555555', tokenEnvVar: 'WHATSAPP_TOKEN_DBTEST' }),
    ).toBeNull();
  });
});

/**
 * A credential stored while an admin's save or disconnect waits for the
 * account's row lock. Under READ COMMITTED a statement's snapshot predates the
 * lock it waits on, so a check folded into the locking statement would not see
 * the credential the lock holder just committed — the save would then move the
 * row to another WABA, or the disconnect would cascade the credential away with
 * no record. Two connections, the store holding the lock while the other waits.
 */
describe('a credential stored while an edit waits for the row', () => {
  async function storeHoldingTheLock(target: { id: string; wabaId: string }) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let stored!: () => void;
    const locked = new Promise<void>((resolve) => (stored = resolve));

    const committing = db.transaction(async (tx) => {
      await storeBusinessToken(tx, {
        accountId: target.id,
        wabaId: target.wabaId,
        token: TOKEN,
        inspection: null,
        businessId: null,
        actor: null,
      });
      stored();
      await held;
    });

    await locked;
    return { committing, release };
  }

  /** Long enough for the second connection to reach the lock and wait on it. */
  const waitOnTheLock = () => new Promise((resolve) => setTimeout(resolve, 300));

  it('the save sees it, and refuses to move the row to another WABA', async () => {
    const egypt = await account('Egypt', '111111');
    const { committing, release } = await storeHoldingTheLock(egypt);

    const refusal = db.transaction((tx) =>
      storedCredentialEditRefusal(tx, egypt.id, { wabaId: '444444', tokenEnvVar: null }),
    );
    await waitOnTheLock();
    release();
    await committing;

    expect(await refusal).toMatch(/belongs to business account 111111/);
  });

  it('the disconnect removes it and records who did', async () => {
    const egypt = await account('Egypt', '111111');
    const mona = await admin();
    const { committing, release } = await storeHoldingTheLock(egypt);

    const removed = db.transaction(async (tx) => {
      const found = await removeStoredCredential(tx, egypt.id, mona);
      await tx.delete(whatsappAccounts).where(eq(whatsappAccounts.id, egypt.id));
      return found;
    });
    await waitOnTheLock();
    release();
    await committing;

    expect(await removed).toBe(true);
    expect((await eventsFor(egypt.id)).map((event) => event.event)).toEqual(['stored', 'removed']);
  });
});

describe('disconnecting the account', () => {
  it('takes the credential with it, and the record of who did it survives both', async () => {
    const egypt = await account('Egypt', '111111');
    const mona = await admin();
    await store(egypt, mona);

    await db.transaction(async (tx) => {
      await removeStoredCredential(tx, egypt.id, mona);
      await tx.delete(whatsappAccounts).where(eq(whatsappAccounts.id, egypt.id));
    });

    expect(await envelopeOf(egypt.id)).toBeNull();
    expect(await eventsFor(egypt.id)).toEqual([
      expect.objectContaining({ event: 'stored' }),
      expect.objectContaining({ event: 'removed', agentLabel: 'Mona Admin' }),
    ]);
  });

  it('cascades even when nothing recorded it — the key is never kept for nothing', async () => {
    const egypt = await account('Egypt', '111111');
    await store(egypt);

    await db.delete(whatsappAccounts).where(eq(whatsappAccounts.id, egypt.id));

    expect(await envelopeOf(egypt.id)).toBeNull();
  });
});

describe('refusals', () => {
  it('records one event per refusal, not one per hourly sync', async () => {
    const egypt = await account('Egypt', '111111');
    await store(egypt);

    await recordCredentialRefusal(egypt.id, 'Session has expired');
    await recordCredentialRefusal(egypt.id, 'Session has expired');

    const status = (await credentialStatuses()).get(egypt.id)!;
    expect(status.lastRefusal).toBe('Session has expired');
    expect((await eventsFor(egypt.id)).map((event) => event.event)).toEqual(['stored', 'refused']);

    await recordCredentialVerified(egypt.id);
    expect((await credentialStatuses()).get(egypt.id)).toMatchObject({
      lastRefusedAt: null,
      lastRefusal: null,
    });

    await recordCredentialRefusal(egypt.id, 'Revoked');
    expect((await eventsFor(egypt.id)).map((event) => event.event)).toEqual([
      'stored',
      'refused',
      'refused',
    ]);
  });

  it('is a no-op for an account with no stored credential', async () => {
    const egypt = await account('Egypt', '111111');
    await recordCredentialRefusal(egypt.id, 'nope');
    expect(await eventsFor(egypt.id)).toEqual([]);
  });
});

describe('rotating the key', () => {
  it('opens every old row on a dry run and writes nothing', async () => {
    const egypt = await account('Egypt', '111111');
    await store(egypt);
    const before = await envelopeOf(egypt.id);
    useKeys(KEY_B, KEY_A);

    expect(await resealStoredCredentials({ dryRun: true })).toEqual({
      examined: 1,
      resealed: 1,
      failed: [],
    });

    expect(await envelopeOf(egypt.id)).toEqual(before);
    expect(await eventsFor(egypt.id)).toHaveLength(1);
  });

  it('moves every row onto the current key, which then opens it alone', async () => {
    const egypt = await account('Egypt', '111111');
    const saudi = await account('Saudi', '222222');
    await store(egypt);
    await store(saudi);
    useKeys(KEY_B, KEY_A);

    expect(await resealStoredCredentials({ dryRun: false })).toEqual({
      examined: 2,
      resealed: 2,
      failed: [],
    });
    // Run again: nothing is left on the old key.
    expect(await resealStoredCredentials({ dryRun: false })).toEqual({
      examined: 0,
      resealed: 0,
      failed: [],
    });

    useKeys(KEY_B);
    expect(await storedTokenFor(egypt)).toBe(TOKEN);
    expect(await storedTokenFor(saudi)).toBe(TOKEN);
    expect((await eventsFor(egypt.id)).map((event) => event.event)).toEqual(['stored', 'resealed']);
    expect((await eventsFor(egypt.id))[1]!.detail).toEqual({
      fromKeyId: parseKeyring(KEY_A, undefined).current.id,
    });
  });

  it('names a row neither key opens, leaves it alone, and still moves the rest', async () => {
    const egypt = await account('Egypt', '111111');
    const saudi = await account('Saudi', '222222');
    useKeys(KEY_C);
    await store(egypt);
    useKeys(KEY_A);
    await store(saudi);
    const stranded = await envelopeOf(egypt.id);
    useKeys(KEY_B, KEY_A);

    const summary = await resealStoredCredentials({ dryRun: false });

    expect(summary).toMatchObject({ examined: 2, resealed: 1 });
    expect(summary!.failed).toEqual([
      { accountId: egypt.id, reason: expect.stringMatching(/neither WHATSAPP_CREDENTIAL_KEY/) },
    ]);
    expect(await envelopeOf(egypt.id)).toEqual(stranded);
  });

  /**
   * The reseal binds a freshly sealed envelope into its update, so an ordinary
   * failure there — a dropped connection, a constraint a later migration adds —
   * would carry it into the job's `last_error`, which is why it is wrapped as
   * `storeBusinessToken`'s insert is. Forced with a trigger refusing any write
   * to `envelope`, dropped whatever the test does, since truncating leaves a
   * trigger in place; `or replace` so a run killed before the drop does not
   * fail the next one.
   */
  it('fails with Postgres’s sentence, never the statement or the new envelope in it', async () => {
    const egypt = await account('Egypt', '111111');
    await store(egypt);
    const before = await envelopeOf(egypt.id);
    useKeys(KEY_B, KEY_A);

    await db.execute(
      sql.raw(`create or replace function test_refuse_envelope_write() returns trigger language plpgsql as $$
        begin raise exception 'refused by the test' using errcode = 'check_violation'; end $$`),
    );
    await db.execute(
      sql.raw(`create or replace trigger test_refuse_envelope_write before update of envelope
        on whatsapp_account_credentials for each row execute function test_refuse_envelope_write()`),
    );
    let failure: Error | null;
    try {
      failure = await resealStoredCredentials({ dryRun: false }).then(
        () => null,
        (error: unknown) => error as Error,
      );
    } finally {
      await db.execute(
        sql.raw(
          `drop trigger if exists test_refuse_envelope_write on whatsapp_account_credentials`,
        ),
      );
      await db.execute(sql.raw(`drop function if exists test_refuse_envelope_write()`));
    }

    expect(failure?.message).toBe('storing the credential failed (23514): refused by the test');
    expect(failure && 'cause' in failure).toBe(false);
    expect(await envelopeOf(egypt.id)).toEqual(before);
    expect((await eventsFor(egypt.id)).map((event) => event.event)).toEqual(['stored']);
  });

  it('skips with no key and nothing stored, and refuses with no key and rows to move', async () => {
    useKeys(undefined);
    expect(await resealStoredCredentials({ dryRun: true })).toBeNull();

    useKeys(KEY_A);
    await store(await account('Egypt', '111111'));
    useKeys(undefined);

    await expect(resealStoredCredentials({ dryRun: true })).rejects.toThrow(CredentialKeyError);
  });
});
