import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * the rule afresh: two cases in one file would otherwise share a file list and
 * one `failures` array.
 *
 * git runs with the variables that point it at a repository removed
 * (`isolatedGitEnv`). A git hook exports GIT_DIR and GIT_INDEX_FILE, and git honours
 * them over `cwd`: run from a pre-commit hook, `git add -A` would stage the
 * fixture's files into the real repository's index.
 */
export async function runRule(rule, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-rules-'));
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
    }
    const env = isolatedGitEnv();
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['add', '-A'], { cwd: root, env });

    vi.resetModules();
    vi.stubEnv('REPO_RULES_ROOT', root);
    const ruleModule = await import(`./rules/${rule}.mjs`);
    const { failures } = await import('./lib.mjs');

    registeredCheck(rule, ruleModule)();
    return failures.map(({ rule: name, where, message }) => ({ rule: name, where, message }));
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The function CI runs for `rule`: the one the RULES table in `repo-rules.mjs`
 * pairs with its name, looked up by that name in the rule's module.
 *
 * Not "the module's first export". A module namespace lists its exports
 * alphabetically, not in declaration order, so the first rule module to export
 * a constant sorting before its check — `ACTION` beside `checkA` — would have
 * had every fixture call the constant. Resolving through the RULES entry also
 * means a fixture cannot test a function CI never calls: if the table names
 * something the module does not export as a function, this says so.
 *
 * `runner` is the source of `repo-rules.mjs`, a parameter only so a test can
 * register a module that is not in the real table.
 */
export function registeredCheck(
  rule,
  ruleModule,
  runner = readFileSync(new URL('./repo-rules.mjs', import.meta.url), 'utf8'),
) {
  const entry = runner.match(new RegExp(`\\[\\s*'${rule}'\\s*,\\s*(\\w+)\\s*\\]`));
  if (!entry) throw new Error(`repo-rules.mjs has no RULES entry named '${rule}'`);
  const name = entry[1];
  if (typeof ruleModule[name] !== 'function') {
    throw new Error(
      `RULES runs ${name} for '${rule}', but rules/${rule}.mjs exports no function by that name`,
    );
  }
  return ruleModule[name];
}

/** `count` files named by `name(i)`, each holding `contents(i)`. */
export function many(count, name, contents) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [name(i), contents(i)]));
}
