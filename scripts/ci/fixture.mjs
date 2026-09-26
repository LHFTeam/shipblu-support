import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

/**
 * Runs one rule against a repository made of `files`, and answers what it
 * reported.
 *
 * The rules read what git tracks, so the fixture is a real repository with
 * every file staged. `lib.mjs` reads the root and the file list when it is
 * first imported, which is why each run resets the module cache and imports
 * the rule afresh: two cases in one file would otherwise share a file list and
 * one `failures` array.
 */
export async function runRule(rule, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-rules-'));
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });

    vi.resetModules();
    vi.stubEnv('REPO_RULES_ROOT', root);
    const ruleModule = await import(`./rules/${rule}.mjs`);
    const { failures } = await import('./lib.mjs');

    const [check] = Object.values(ruleModule);
    check();
    return failures.map(({ rule: name, where, message }) => ({ rule: name, where, message }));
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
}

/** `count` files named by `name(i)`, each holding `contents(i)`. */
export function many(count, name, contents) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [name(i), contents(i)]));
}
