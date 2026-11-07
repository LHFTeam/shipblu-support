import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { logger } from '@/lib/log';
import { backoffMs, classifyFailure } from '@/lib/queue/backoff';

const log = logger('schema_gate');

/**
 * The worker and the cron jobs wait, at startup, until the database has every
 * migration their own build carries.
 *
 * Every production service deploys itself once the checks on `main` pass, all
 * six together, and only the web service migrates, in its `preDeployCommand`.
 * On `eb69c8c` the crons, which build with `npm ci` alone, were live a minute
 * and a half before that migration ran, and the worker in the same second. Code
 * whose schema names a column the database lacks fails every insert into that
 * table, because Drizzle names every column, and every whole-row select of it.
 * And when the web deploy fails, nothing would ever stop them: they stay on the
 * new code against the old schema, with `main` green. Deploying the web service
 * first, by hand, used to hold the order; this holds it whatever order the six
 * deploys finish in (`docs/PROJECT-STATE.md` §2).
 *
 * "Applied" is the question Drizzle's own migrator asks: the newest
 * `created_at` in `drizzle.__drizzle_migrations` is at least the `when` of the
 * build's newest journal entry. A database ahead of the build passes at once —
 * a worker rolled back, or a release whose web half landed first — since old
 * code meeting a newer schema is the direction every migration is written to
 * survive.
 *
 * Only the migrations. `db/sql/` replays after them, in the same
 * `preDeployCommand`, and is not waited for, because nothing records that it
 * ran.
 *
 * While it waits, the worker runs no job at all, not only the ones the new
 * schema touches: no send on any channel, no CSAT, no sweep and no automation,
 * and the crons wait too, `snapshot_backlog`'s hourly sample and the nightly
 * rollup with them. On a release that migrates cleanly that is the gap between
 * the worker starting and the migration committing, less the minute Render
 * keeps the old worker running beside the new one; on `eb69c8c` the two landed
 * in the same second. On a web deploy that fails, it lasts until somebody
 * fixes that deploy or rolls the worker and the crons back, and every hour of
 * it is a backlog snapshot nobody can take afterwards. That is the trade: a
 * stop everybody sees, where code running against the wrong schema fails only
 * what touches the changed tables — quietly, and for a column on
 * `conversations` nearly everything.
 *
 * It gives up after `GATE_TIMEOUT_MS` by throwing, so a web deploy that never
 * migrates is a worker Render keeps restarting and cron runs that fail, each
 * naming the migration. A job somebody runs by hand does not wait at all, and a
 * job later in the same cron run does not wait again for a migration an
 * earlier one gave up on (`jobWaitPolicy`).
 *
 * A rollback runbook that deletes a migration's row (`db/runbooks/`) makes the
 * database older than every build carrying that migration, so this refuses
 * them: the runbook puts the worker and the crons back on the earlier build
 * with the web service.
 */

/** Long enough for a web build and its migrations; a failed one is not waited out. */
export const GATE_TIMEOUT_MS = 15 * 60_000;

/** One cheap read every five seconds while the web service migrates. */
const POLL_MS = 5_000;

/** A line a minute while waiting, so the log says why nothing is running. */
const REPORT_EVERY_MS = 60_000;

/** One entry of `db/migrations/meta/_journal.json`, as Drizzle names it. */
type JournalEntry = { tag: string; when: number };

type GateDeps = {
  /** The build's journal, oldest first, as `readJournal` returns it. */
  journal: readonly JournalEntry[];
  /** The newest `created_at` the database has recorded, or null before any. */
  readApplied: () => Promise<number | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs?: number;
  /** Set when this caller does not wait: why, for the refusal. */
  notWaiting?: string;
};

type WaitPolicy = Pick<GateDeps, 'timeoutMs' | 'notWaiting'>;

/**
 * How long `npm run job` waits for the migration.
 *
 * A cron waits as the worker does, since a cron's build is live before the web
 * service's migration on every release that has one. A person at a terminal
 * gets the answer at once: the wait exists for a deploy in flight, and a
 * fifteen-minute hang with a line a minute is no way to say "this checkout is
 * a migration ahead of that database". And a job after one that gave up — a
 * cron chained with `;`, as the template sync and the backlog snapshot are —
 * would only wait the same fifteen minutes for the same answer.
 */
export function jobWaitPolicy(interactive: boolean, gaveUpEarlier: boolean): WaitPolicy {
  if (interactive) {
    return {
      timeoutMs: 0,
      notWaiting:
        'it was run by hand: apply the migration first (the web deploy of this ' +
        'commit, or `npm run db:migrate`), or run the job from the build the database is on',
    };
  }
  if (gaveUpEarlier) {
    return { timeoutMs: 0, notWaiting: 'a job earlier in this run already waited for it' };
  }
  return { timeoutMs: GATE_TIMEOUT_MS };
}

/** The build's own journal: the migrations this code was generated against. */
export async function readJournal(root = process.cwd()): Promise<JournalEntry[]> {
  const file = path.join(root, 'db/migrations/meta/_journal.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { entries?: unknown };
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return entries
    .filter(
      (entry): entry is JournalEntry =>
        typeof (entry as JournalEntry).tag === 'string' &&
        typeof (entry as JournalEntry).when === 'number',
    )
    .map(({ tag, when }) => ({ tag, when }))
    .sort((a, b) => a.when - b.when);
}

/**
 * The newest migration the database has recorded, as Drizzle's migrator reads
 * it, or null on a database no migration has touched yet.
 */
export async function appliedThrough(): Promise<number | null> {
  try {
    const rows = await db.execute<{ through: string | null }>(sql`
      select max(created_at)::text as through from drizzle.__drizzle_migrations
    `);
    const through = rows[0]?.through;
    return through == null ? null : Number(through);
  } catch (error) {
    // 42P01: no such table, 3F000: no such schema. Both are a database that has
    // never been migrated, which is "behind", not a failure to read.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '42P01' || code === '3F000') return null;
    throw error;
  }
}

export async function waitForMigrations({
  journal,
  readApplied,
  sleep,
  now,
  timeoutMs = GATE_TIMEOUT_MS,
  notWaiting,
}: GateDeps): Promise<void> {
  const newest = journal.at(-1);
  if (!newest) return;

  const started = now();
  let reportedAt: number | null = null;
  let waited = false;
  let failures = 0;
  let lastError: unknown = null;

  for (;;) {
    let applied: number | null | undefined;
    try {
      applied = await readApplied();
      failures = 0;
    } catch (error) {
      failures += 1;
      lastError = error;
    }

    if (applied != null && applied >= newest.when) {
      if (waited) {
        log.info(`${newest.tag} is applied, starting`, {
          waited_s: Math.round((now() - started) / 1000),
        });
      }
      return;
    }

    const elapsed = now() - started;
    if (elapsed >= timeoutMs) {
      const has = applied === undefined ? 'unreadable' : describe(journal, applied);
      throw new Error(
        notWaiting
          ? `the database has migration ${has} and this build needs ${newest.tag}; ` +
              `not waiting for it, because ${notWaiting}`
          : `gave up after ${Math.round(timeoutMs / 60_000)} minutes waiting for migration ` +
              `${newest.tag}, which the web service's preDeployCommand applies ` +
              `(the database has ${has}). Is the web deploy of this commit failing?`,
        { cause: lastError ?? undefined },
      );
    }

    let delay = POLL_MS;
    if (failures > 0) {
      delay = backoffMs(classifyFailure(lastError), failures);
      log.warn(
        `could not read the applied migrations (attempt ${failures}), ` +
          `retrying in ${Math.round(delay / 1000)}s`,
        lastError,
      );
    } else if (reportedAt === null || now() - reportedAt >= REPORT_EVERY_MS) {
      log.info(`waiting for migration ${newest.tag}, which the web service's preDeploy applies`, {
        database_has: describe(journal, applied ?? null),
      });
      reportedAt = now();
    }

    waited = true;
    await sleep(Math.min(delay, timeoutMs - elapsed));
  }
}

/** The tag of the database's newest migration where this build knows it. */
function describe(journal: readonly JournalEntry[], applied: number | null): string {
  if (applied === null) return 'none';
  return journal.find((entry) => entry.when === applied)?.tag ?? String(applied);
}

/**
 * A job that waited the full time leaves this behind for the jobs after it in
 * the same run, which share the instance's temporary directory. It only skips
 * the wait: each still reads the database once, so a run after the migration
 * landed starts.
 */
function gaveUpMarker(tag: string): string {
  return path.join(os.tmpdir(), `shipblu-schema-gate-gave-up-${tag}`);
}

/** The gate as the worker and `npm run job` call it. */
export async function waitForSchema(caller: 'worker' | 'job'): Promise<void> {
  const journal = await readJournal();
  const marker = gaveUpMarker(journal.at(-1)?.tag ?? 'none');
  const policy: WaitPolicy =
    caller === 'worker'
      ? { timeoutMs: GATE_TIMEOUT_MS }
      : jobWaitPolicy(process.stdin.isTTY === true, existsSync(marker));

  try {
    await waitForMigrations({
      journal,
      readApplied: appliedThrough,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      ...policy,
    });
  } catch (error) {
    if (caller === 'job' && policy.notWaiting === undefined) {
      await writeFile(marker, '').catch(() => {
        // Best-effort: without it the next job in the run waits again, as before.
      });
    }
    throw error;
  }
}
