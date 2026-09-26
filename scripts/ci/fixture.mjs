import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { isolatedGitEnv } from './git-env.mjs';

/**
 * Runs one rule against a repository made of `files`, and answers what it
 * reported.
 *
 * The rules read what git tracks, so the fixture is a real repository with
 * every file staged. `lib.mjs` reads the root and the file list when it is
 * first imported, which is why each run resets the module cache and imports
 * the RULES table afresh — and with it every rule module and `lib.mjs`: two
 * cases in one file would otherwise share a file list and one `failures` array,
 * and a table imported before `REPO_RULES_ROOT` was set would have its checks
 * read the real repository.
 *
 * git runs with the variables that point it at a repository removed
 * (`isolatedGitEnv`). A git hook exports GIT_DIR and GIT_INDEX_FILE, and git honours
 * them over `cwd`: run from a pre-commit hook, `git add -A` would stage the
 * fixture's files into the real repository's index.
 *
 * `loadTable` stands in for `import('./rules.mjs')` only so a test can register
 * an entry the real table does not have. It is called inside the reset, so
 * whatever it imports sees the fixture too.
 *
 * `prepare` is for a rule that reads history rather than the tree — commits, a
 * base ref. It runs after the files are staged and is handed `git`, bound to
 * the fixture with the same isolation and an identity to commit under, and
 * `write`, which puts a file into the fixture's working tree.
 */
export async function runRule(
  rule,
  files,
  { loadTable = () => import('./rules.mjs'), prepare } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-rules-'));
  try {
    const write = (file, contents) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
    };
    for (const [file, contents] of Object.entries(files)) write(file, contents);
    const env = isolatedGitEnv();
    const git = (...args) =>
      execFileSync('git', [...IDENTITY, ...args], { cwd: root, env, encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A');
    await prepare?.({ git, write });

    vi.resetModules();
    vi.stubEnv('REPO_RULES_ROOT', root);
    const { RULES } = await loadTable();
    const { failures, runCheck } = await import('./lib.mjs');

    // Through the runner's own wrapper, so a check that throws is the
    // "(check itself)" failure CI would print, not a rejection.
    runCheck(rule, registeredCheck(rule, RULES));
    return failures.map(({ rule: name, where, message }) => ({ rule: name, where, message }));
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}

// Commits in a fixture must not depend on whoever runs the tests having an
// identity configured, or on their signing setup.
const IDENTITY = [
  '-c',
  'user.name=repo-rules fixture',
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/**
 * The function CI runs for `rule`: the one the RULES table pairs with its name.
 *
 * Looked up in the table itself rather than by reading `repo-rules.mjs` as
 * text. Parsing the source meant building a pattern from the rule name, where a
 * metacharacter would match some other entry, and then resolving the identifier
 * it found as an export of the rule module — which named the wrong thing, or
 * nothing, for an entry imported under an alias or wrapped in a closure. The
 * table entry is the function CI calls, so there is nothing left to resolve,
 * and a fixture still cannot test a rule CI never runs.
 */
export function registeredCheck(rule, table) {
  const entry = table.find(([name]) => name === rule);
  if (!entry) throw new Error(`the RULES table has no entry named '${rule}'`);
  const [, run] = entry;
  if (typeof run !== 'function') {
    throw new Error(`the RULES entry for '${rule}' is not a function`);
  }
  return run;
}

/** `count` files named by `name(i)`, each holding `contents(i)`. */
export function many(count, name, contents) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [name(i), contents(i)]));
}
