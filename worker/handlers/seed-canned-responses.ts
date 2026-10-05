import { eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses } from '@/db/schema';
import { CANNED_LIBRARY, librarySeedKey } from '@/lib/tickets/canned-library';
import { cannedBodyColumns } from '@/lib/tickets/canned-write';
import type { ClaimedJob } from '@/lib/queue';
import { parseJobPayload } from '@/lib/queue/payloads';
import { logger } from '@/lib/log';

/**
 * Puts the starter library of canned responses into the console.
 *
 * A job rather than part of `db/seed.ts`, because that seed is the
 * configuration the app cannot work without and every database test puts it
 * back after truncating — and a library of replies is neither. It is content a
 * team is expected to take over: reword, rename, regroup, delete. The content
 * itself is `lib/tickets/canned-library.ts`; this file is only the upsert, and
 * it is shaped like `seed_console_handbook` for the same reasons.
 *
 * **What it owns, and what it leaves alone.**
 *
 *  - A response the library has and the table does not is **inserted**,
 *    `global`, so every agent's picker offers it.
 *  - A response the table already has is found by `seed_key`, not by title,
 *    so one the team renamed is still recognised rather than duplicated.
 *  - Its title, folder and bodies are compared with what the library would
 *    write. Equal means nothing to do. Different is either somebody's
 *    improvement or a content fix in this repository not yet pushed, and only
 *    a person can tell those apart — so without `overwrite=true` the row is
 *    left as it is and named in the report. With it, the row is rewritten.
 *  - `visibility`, `agent_id`, `group_id` and `usage_count` are never touched
 *    after insert. Narrowing a response to one team is a decision somebody
 *    made, and the count is the team's record of what it actually sends.
 *
 * **`overwrite=true` has no undo.** Unlike the handbook, a canned response has
 * no version table, so an edit it replaces is gone. That is why every drifted
 * response is named by key and title rather than counted, and why a run with
 * `dryRun=true overwrite=true` reports exactly what a real one would replace.
 *
 * **A response deleted in the console comes back on the next run.** Nothing
 * records the deletion, and inventing a tombstone for a job run a handful of
 * times would be machinery out of proportion to the problem. Retiring an entry
 * for good means removing it from the library in this repository.
 *
 * **A run with nothing to do issues no UPDATE**, for the reason the handbook's
 * header gives: `touch_updated_at` moves the timestamp on any UPDATE, values
 * changed or not, and a re-run that restamps every row is a re-run that makes
 * the table's history unreadable.
 *
 * Idempotent, and enqueued **without a `dedupeKey`**: a key is spent for good
 * rather than until the job finishes (`AGENTS.md`), so keying this would make
 * the second run — the one that ships a content fix — silently do nothing.
 */

type Tally = {
  created: number;
  rewritten: number;
  unchanged: number;
  /** Differ from the library and were left alone, by seed key and current title. */
  drifted: { key: string; title: string }[];
  /**
   * Responses reached per folder, counted as the run reaches them rather than
   * read back off `CANNED_LIBRARY` — a table printed from the constant that
   * produced the work is an echo, and would report a full folder the run
   * never got to.
   */
  perFolder: Map<string, number>;
};

export async function seedCannedResponses(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'seed_canned_responses');
  const dryRun = payload.dryRun === true;
  const overwrite = payload.overwrite === true;

  const tally: Tally = {
    created: 0,
    rewritten: 0,
    unchanged: 0,
    drifted: [],
    perFolder: new Map(),
  };

  // One read for every seeded row rather than one per entry: the library is a
  // few dozen rows and the table is small, so this is the whole comparison set.
  const seeded = await db
    .select({
      id: cannedResponses.id,
      seedKey: cannedResponses.seedKey,
      title: cannedResponses.title,
      folder: cannedResponses.folder,
      bodyTextAr: cannedResponses.bodyTextAr,
      bodyHtmlAr: cannedResponses.bodyHtmlAr,
      bodyTextEn: cannedResponses.bodyTextEn,
      bodyHtmlEn: cannedResponses.bodyHtmlEn,
      bodyText: cannedResponses.bodyText,
      bodyHtml: cannedResponses.bodyHtml,
    })
    .from(cannedResponses)
    .where(isNotNull(cannedResponses.seedKey));

  const bySeedKey = new Map(seeded.map((row) => [row.seedKey, row]));

  for (const folder of CANNED_LIBRARY) {
    tally.perFolder.set(folder.name, 0);

    for (const response of folder.responses) {
      tally.perFolder.set(folder.name, (tally.perFolder.get(folder.name) ?? 0) + 1);

      const seedKey = librarySeedKey(response.key);
      const values = {
        title: response.title,
        folder: folder.name,
        ...cannedBodyColumns({ ar: response.ar, en: response.en }),
      };

      const row = bySeedKey.get(seedKey);

      if (!row) {
        if (dryRun) {
          tally.created += 1;
          continue;
        }

        // The conflict target is the unique index, so a second run racing this
        // one inserts nothing rather than failing — and is counted as finding
        // the row, which by the time it looked is what happened.
        const inserted = await db
          .insert(cannedResponses)
          .values({ ...values, seedKey, visibility: 'global' })
          .onConflictDoNothing({ target: cannedResponses.seedKey })
          .returning({ id: cannedResponses.id });

        if (inserted.length > 0) tally.created += 1;
        else tally.unchanged += 1;
        continue;
      }

      // Field by field, so a row that already says what the library says is
      // not written to at all — see the header on `touch_updated_at`.
      const changed = (Object.keys(values) as (keyof typeof values)[]).some(
        (key) => row[key] !== values[key],
      );

      if (!changed) {
        tally.unchanged += 1;
        continue;
      }

      if (!overwrite) {
        tally.drifted.push({ key: response.key, title: row.title });
        continue;
      }

      tally.rewritten += 1;
      if (!dryRun) {
        await db.update(cannedResponses).set(values).where(eq(cannedResponses.id, row.id));
      }
    }
  }

  report(tally, { dryRun, overwrite });
}

function report(tally: Tally, options: { dryRun: boolean; overwrite: boolean }): void {
  const log = logger('seed_canned_responses');

  log.info(
    `responses ${tally.created} created, ${tally.rewritten} rewritten, ` +
      `${tally.unchanged} already current`,
    { dry_run: options.dryRun, overwrite: options.overwrite },
  );

  // Named one by one rather than counted, because `overwrite=true` cannot be
  // undone and the operator deciding whether to run it needs to know which
  // responses it would replace — a number does not say whether one of them is
  // the reply the team rewrote last week.
  if (tally.drifted.length > 0) {
    log.info(
      `${tally.drifted.length} response(s) differ from the library and were left as they are; ` +
        `re-run with overwrite=true to replace them`,
    );
    for (const drifted of tally.drifted) {
      log.info(`differs: "${drifted.title}"`, { key: drifted.key });
    }
  }

  log.info(`${'folder'.padEnd(36)}${'reached'.padStart(8)}`);
  for (const [folder, reached] of tally.perFolder) {
    log.info(`${folder.padEnd(36)}${String(reached).padStart(8)}`);
  }
}
