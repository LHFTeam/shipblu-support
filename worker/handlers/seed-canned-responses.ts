import { eq, like } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses } from '@/db/schema';
import { CANNED_LIBRARY, LIBRARY_SEED_PREFIX, librarySeedKey } from '@/lib/tickets/canned-library';
import { cannedBodyColumns } from '@/lib/tickets/canned-write';
import { PermanentJobError, type ClaimedJob } from '@/lib/queue';
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
 *  - Its title, folder and the two texts are compared with the library's —
 *    what a person writes, and nothing derived from it. Equal means nothing to
 *    do. Different is either somebody's improvement or a content fix in this
 *    repository not yet pushed, and only a person can tell those apart — so
 *    without `overwrite=true` the row is left as it is and named in the
 *    report. With it, the row is rewritten.
 *  - The HTML and the superseded body pair are derived, so they are never the
 *    reason a row counts as changed. Comparing them would make a change to
 *    `textToHtml` read as the team having edited every seeded response, and
 *    the only way to ship it would be the overwrite that reverts their real
 *    edits along with it.
 *  - `visibility`, `agent_id`, `group_id` and `usage_count` are never touched
 *    after insert. Narrowing a response to one team is a decision somebody
 *    made, and the count is the team's record of what it actually sends.
 *
 * **`overwrite=true` has no undo**, because a canned response, unlike a
 * handbook article, has no version table. So it is scoped with `keys=` to the
 * entries a content fix actually touches — shipping a corrected COD ceiling
 * must not revert the fifteen titles the team renamed for search — and every
 * response it replaces is named by key and current title, in a dry run as in a
 * real one, so the log says afterwards whose edit went.
 *
 * **A response deleted in the console comes back on the next run.** Nothing
 * records the deletion, and inventing a tombstone for a job run a handful of
 * times would be machinery out of proportion to the problem. And **an entry
 * removed from the library is not deleted from the table**: its row may be
 * what an automation rule sends, and a seed that deleted it would silence the
 * rule. So the run names every seeded row the library no longer has, and
 * retiring one for good is two steps — out of the library, then out of the
 * console.
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

type Named = { key: string; title: string };

type Tally = {
  created: number;
  unchanged: number;
  /** Differ from the library and were left alone. */
  drifted: Named[];
  /** Replaced with the library's text by `overwrite=true`, or would be in a dry run. */
  replaced: Named[];
  /** Seeded once, and no longer in the library. */
  orphaned: Named[];
};

export async function seedCannedResponses(job: ClaimedJob): Promise<void> {
  const payload = parseJobPayload(job, 'seed_canned_responses');
  const dryRun = payload.dryRun === true;
  const overwrite = payload.overwrite === true;
  const entries = selectEntries(payload.keys);

  const tally: Tally = { created: 0, unchanged: 0, drifted: [], replaced: [], orphaned: [] };

  // One read for every seeded row rather than one per entry: the library is a
  // few dozen rows and the table is small, so this is the whole comparison set.
  const seeded = await db
    .select({
      id: cannedResponses.id,
      seedKey: cannedResponses.seedKey,
      title: cannedResponses.title,
      folder: cannedResponses.folder,
      bodyTextAr: cannedResponses.bodyTextAr,
      bodyTextEn: cannedResponses.bodyTextEn,
    })
    .from(cannedResponses)
    .where(like(cannedResponses.seedKey, `${LIBRARY_SEED_PREFIX}%`));

  const bySeedKey = new Map(seeded.map((row) => [row.seedKey, row]));

  const missing: (typeof cannedResponses.$inferInsert)[] = [];

  for (const { folder, response } of entries) {
    const seedKey = librarySeedKey(response.key);
    const values = {
      title: response.title,
      folder,
      ...cannedBodyColumns({ ar: response.ar, en: response.en }),
    };

    const row = bySeedKey.get(seedKey);
    if (!row) {
      missing.push({ ...values, seedKey, visibility: 'global' });
      continue;
    }

    // What a person writes, field by field, so a row that already says what
    // the library says is not written to at all — see the header on
    // `touch_updated_at`, and on why the derived columns are not compared.
    const changed =
      row.title !== values.title ||
      row.folder !== values.folder ||
      row.bodyTextAr !== values.bodyTextAr ||
      row.bodyTextEn !== values.bodyTextEn;

    if (!changed) {
      tally.unchanged += 1;
    } else if (!overwrite) {
      tally.drifted.push({ key: response.key, title: row.title });
    } else {
      tally.replaced.push({ key: response.key, title: row.title });
      if (!dryRun) {
        await db.update(cannedResponses).set(values).where(eq(cannedResponses.id, row.id));
      }
    }
  }

  if (dryRun) {
    tally.created = missing.length;
  } else if (missing.length > 0) {
    // One statement for every missing row. The conflict target is the unique
    // index, so a second run racing this one inserts nothing rather than
    // failing — and a row it lost the race for is counted as found, which by
    // the time it looked is what happened.
    const inserted = await db
      .insert(cannedResponses)
      .values(missing)
      .onConflictDoNothing({ target: cannedResponses.seedKey })
      .returning({ id: cannedResponses.id });
    tally.created = inserted.length;
    tally.unchanged += missing.length - inserted.length;
  }

  const known = new Set(
    CANNED_LIBRARY.flatMap((f) => f.responses.map((r) => librarySeedKey(r.key))),
  );
  for (const row of seeded) {
    if (row.seedKey && !known.has(row.seedKey)) {
      tally.orphaned.push({ key: row.seedKey.slice(LIBRARY_SEED_PREFIX.length), title: row.title });
    }
  }

  report(tally, { dryRun, overwrite, scoped: entries.length < librarySize() });
}

/**
 * The library entries this run covers: all of them, or the ones `keys` names.
 *
 * A key the library does not have is refused rather than skipped. The option
 * exists to aim an irreversible overwrite, and a misspelt key would otherwise
 * aim it at nothing and report a clean run.
 */
function selectEntries(keys: string | undefined) {
  const all = CANNED_LIBRARY.flatMap((folder) =>
    folder.responses.map((response) => ({ folder: folder.name, response })),
  );
  if (keys === undefined) return all;

  const wanted = keys
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (wanted.length === 0) {
    throw new PermanentJobError('seed_canned_responses: keys names no library entry');
  }

  const unknown = wanted.filter((key) => !all.some(({ response }) => response.key === key));
  if (unknown.length > 0) {
    throw new PermanentJobError(
      `seed_canned_responses: not in the library — ${unknown.join(', ')}`,
    );
  }

  return all.filter(({ response }) => wanted.includes(response.key));
}

function librarySize(): number {
  return CANNED_LIBRARY.reduce((sum, folder) => sum + folder.responses.length, 0);
}

function report(
  tally: Tally,
  options: { dryRun: boolean; overwrite: boolean; scoped: boolean },
): void {
  const log = logger('seed_canned_responses');

  log.info(
    `responses ${tally.created} created, ${tally.replaced.length} rewritten, ` +
      `${tally.unchanged} already current`,
    { dry_run: options.dryRun, overwrite: options.overwrite, scoped: options.scoped },
  );

  // Every list below is named one by one rather than counted. A number does
  // not say whether one of them is the reply the team rewrote last week, and
  // that is the question each of these lines exists to answer.
  if (tally.drifted.length > 0) {
    log.info(
      `${tally.drifted.length} response(s) differ from the library and were left as they are; ` +
        `re-run with overwrite=true keys=<key,...> to replace the ones that should go`,
    );
    for (const one of tally.drifted) log.info(`differs: "${one.title}"`, { key: one.key });
  }

  // The irreversible half, named whether it happened or would have, so the
  // log of a real run records whose edits it took and a dry run is the same
  // list in advance.
  if (tally.replaced.length > 0) {
    log.info(
      options.dryRun
        ? `${tally.replaced.length} response(s) would be replaced with the library's text`
        : `${tally.replaced.length} response(s) replaced with the library's text; there is no undo`,
    );
    for (const one of tally.replaced) log.info(`replaces: "${one.title}"`, { key: one.key });
  }

  if (tally.orphaned.length > 0) {
    log.info(
      `${tally.orphaned.length} seeded response(s) are no longer in the library and were left ` +
        `in place; delete them in the console if they should go`,
    );
    for (const one of tally.orphaned)
      log.info(`not in the library: "${one.title}"`, { key: one.key });
  }
}
