import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, fail } from '../lib.mjs';

/**
 * Generated files are not hand-edited.
 *
 * db/migrations is generated from db/schema by `npm run db:generate`. Editing a
 * migration by hand makes the snapshot disagree with the SQL, and drizzle then
 * generates the *next* migration against a schema state the database was never
 * in. The drift check in CI runs the generator and diffs; this catches the other
 * half — an edit to a migration that has already been applied everywhere.
 *
 * `meta/_journal.json` is the one file here that a correct change *must* modify:
 * it is drizzle's index of migrations, and generating one appends an entry to
 * it. Failing every `M` under db/migrations therefore made adding any migration
 * impossible — this rule rejected the first one that met it, which was a pair of
 * `ADD COLUMN`s with no hand-editing anywhere in the diff. So the journal is
 * checked for what actually matters instead: that the entries already on the
 * base branch are untouched and the change only appends. Rewriting or dropping
 * one still fails, which is the case the rule was written for — a renumbered or
 * removed migration silently changes what a fresh database replays.
 */
export function checkMigrationsNotHandEdited() {
  const rule = 'generated-files';
  const base = process.env.GITHUB_BASE_REF;
  if (!base) return; // Only meaningful against a base branch, i.e. on a PR.

  let changed;
  try {
    changed = execFileSync(
      'git',
      ['diff', '--name-status', `origin/${base}...HEAD`, '--', 'db/migrations'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    );
  } catch {
    return; // No base fetched; the drift check still covers the common case.
  }

  for (const line of changed.split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    if (status !== 'M' && status !== 'D') continue;

    if (file === JOURNAL && status === 'M') {
      checkJournalAppendOnly(rule, base);
      continue;
    }

    fail(
      rule,
      file,
      `an existing migration was ${status === 'M' ? 'modified' : 'deleted'} — migrations are generated and append-only; change db/schema/ and run npm run db:generate`,
    );
  }
}

const JOURNAL = 'db/migrations/meta/_journal.json';

/**
 * The journal grew, and nothing already in it moved.
 *
 * Entry order is what a fresh database replays, so an edit to an existing entry
 * is the failure worth catching — it changes history that has already run
 * everywhere. An appended entry is just the new migration announcing itself.
 */
function checkJournalAppendOnly(rule, base) {
  let baseText;
  try {
    baseText = execFileSync('git', ['show', `origin/${base}:${JOURNAL}`], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch {
    return; // Not on the base branch yet, so there is no history to preserve.
  }

  let before;
  let after;
  try {
    before = JSON.parse(baseText).entries ?? [];
    after = JSON.parse(readFileSync(path.join(ROOT, JOURNAL), 'utf8')).entries ?? [];
  } catch (error) {
    fail(rule, JOURNAL, `could not be read as drizzle's journal: ${error.message}`);
    return;
  }

  if (after.length < before.length) {
    fail(rule, JOURNAL, 'entries were removed — the journal is append-only');
    return;
  }

  for (const [index, entry] of before.entries()) {
    if (JSON.stringify(entry) !== JSON.stringify(after[index])) {
      fail(
        rule,
        JOURNAL,
        `entry ${index} (${entry.tag}) was rewritten — the journal is append-only, so a new ` +
          `migration may only add an entry after the ones already on ${base}`,
      );
      return;
    }
  }
}
