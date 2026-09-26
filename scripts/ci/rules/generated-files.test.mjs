import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isolatedGitEnv } from '../git-env.mjs';
import { runRule } from '../fixture.mjs';

/**
 * generated-files reads history, not the tree: it diffs HEAD against
 * `origin/$GITHUB_BASE_REF`. So each case commits a base, points
 * `refs/remotes/origin/main` at it, and commits the change on top — the shape
 * of a pull request checkout.
 */

const MIGRATION = 'db/migrations/0000_first.sql';
const JOURNAL = 'db/migrations/meta/_journal.json';
const journal = (...tags) => JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) });

const base = { [MIGRATION]: 'create table a ();\n', [JOURNAL]: journal('0000_first') };

/** Commits the staged files as the base branch, then `change` on top of it. */
const pullRequest =
  (change) =>
  ({ git, write }) => {
    git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    for (const [file, contents] of Object.entries(change)) write(file, contents);
    git('add', '-A');
    git('commit', '-qm', 'change');
  };

afterEach(() => vi.unstubAllEnvs());

describe('generated-files', () => {
  it('fails a migration edited after it reached the base branch', async () => {
    vi.stubEnv('GITHUB_BASE_REF', 'main');
    const found = await runRule('generated-files', base, {
      prepare: pullRequest({ [MIGRATION]: 'create table b ();\n' }),
    });
    expect(found.map((f) => f.where)).toEqual([MIGRATION]);
  });

  it('accepts a new migration and the journal entry announcing it', async () => {
    vi.stubEnv('GITHUB_BASE_REF', 'main');
    const found = await runRule('generated-files', base, {
      prepare: pullRequest({
        'db/migrations/0001_second.sql': 'create table b ();\n',
        [JOURNAL]: journal('0000_first', '0001_second'),
      }),
    });
    expect(found).toEqual([]);
  });

  it('fails a rewritten journal entry', async () => {
    vi.stubEnv('GITHUB_BASE_REF', 'main');
    const found = await runRule('generated-files', base, {
      prepare: pullRequest({ [JOURNAL]: journal('0000_renamed') }),
    });
    expect(found.map((f) => f.message)).toEqual([
      expect.stringMatching(/entry 0 .* was rewritten/),
    ]);
  });
});

describe('generated-files under an inherited GIT_DIR', () => {
  const git = (cwd, ...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
      ].concat(args),
      { cwd, encoding: 'utf8', env: isolatedGitEnv() },
    );
  let other;

  afterEach(() => {
    if (other) rmSync(other, { recursive: true, force: true });
  });

  it("diffs the fixture's history, not the repository GIT_DIR names", async () => {
    // Another repository whose own pull request edits a different migration.
    // Had the rule followed GIT_DIR, this is the file it would have reported.
    other = mkdtempSync(path.join(tmpdir(), 'repo-rules-other-'));
    const elsewhere = 'db/migrations/9999_elsewhere.sql';
    mkdirSync(path.join(other, 'db/migrations'), { recursive: true });
    writeFileSync(path.join(other, elsewhere), 'create table x ();\n');
    git(other, 'init', '-q');
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'base');
    git(other, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(path.join(other, elsewhere), 'create table y ();\n');
    git(other, 'commit', '-qam', 'change');

    vi.stubEnv('GITHUB_BASE_REF', 'main');
    vi.stubEnv('GIT_DIR', path.join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);

    const found = await runRule('generated-files', base, {
      prepare: pullRequest({ [MIGRATION]: 'create table b ();\n' }),
    });

    expect(found.map((f) => f.where)).toEqual([MIGRATION]);
  });
});
