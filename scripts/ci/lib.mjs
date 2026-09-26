import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What every rule in `rules/` shares: the repository root, the list of files git
 * tracks, where a violation is recorded, and the scanning and import-graph
 * helpers. `repo-rules.mjs` runs the rules and prints what `fail` recorded.
 */

/**
 * The repository the rules read: this one, or the one `REPO_RULES_ROOT` names.
 *
 * The override exists for the rules' own tests, which build a small git
 * repository per case and point the rules at it. Nothing else sets it, and CI
 * runs the rules against the checkout exactly as before.
 */
export const ROOT = process.env.REPO_RULES_ROOT
  ? path.resolve(process.env.REPO_RULES_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const failures = [];

/** Records a violation. `where` is a path (plus optional :line) for the reader. */
export function fail(rule, where, message) {
  failures.push({ rule, where, message });
}

export function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Every file git actually tracks, which is the right population for these rules:
 * a build artefact or a local .env sitting in the working tree is not the
 * repository's problem, and node_modules would swamp every scan in `rules/`.
 */
export const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const trackedSource = tracked.filter((f) => /\.(ts|tsx|mts|mjs)$/.test(f));

/**
 * The checks themselves are not application code and are never scanned.
 *
 * A checker necessarily contains the patterns it looks for.
 * `rules/sanitiser.mjs` holds the literal `from 'sanitize-html'` it searches
 * for, and db-invariants.sql raises an exception whose message says FORCE ROW
 * LEVEL SECURITY — so scanning scripts/ci reports every rule as violated by the
 * rule.
 *
 * Excluded here, once, rather than by a special case inside each check: the next
 * rule added would otherwise flag itself the first time it runs on a branch
 * where these files are tracked. That is exactly how this was found — the checks
 * passed while the files were still untracked and failed the moment they were
 * committed.
 */
const CHECKER_PREFIX = 'scripts/ci/';
export const scannable = tracked.filter((f) => !f.startsWith(CHECKER_PREFIX));
export const scannableSource = trackedSource.filter((f) => !f.startsWith(CHECKER_PREFIX));

/** Line number of the first match, for an error message that points somewhere. */
export function lineOf(contents, index) {
  return contents.slice(0, index).split('\n').length;
}

/**
 * Comments blanked, newlines kept so line numbers still point at the source.
 *
 * This codebase explains its rules in prose next to the code that follows them —
 * `platform.ts` spends a paragraph on why `events[0]` is meaningless. Scanning
 * raw text reports those paragraphs as violations of the rule they describe.
 */
export function stripComments(contents) {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

export function scan(files, pattern, onMatch) {
  for (const file of files) {
    const raw = readFileSync(path.join(ROOT, file), 'utf8');
    const contents = /\.(ts|tsx|mts|mjs)$/.test(file) ? stripComments(raw) : raw;
    for (const match of contents.matchAll(pattern)) {
      onMatch(file, lineOf(contents, match.index), match, contents);
    }
  }
}

/**
 * Where a specifier points, as a repo-relative path, or null for a package.
 *
 * Shared by the two checks that need to know what imports what. Both used to
 * carry a private copy, which is the shape this file exists to stop.
 */
export function resolveModule(spec, fromFile) {
  const base = spec.startsWith('@/')
    ? path.join(ROOT, spec.slice(2))
    : spec.startsWith('.')
      ? path.resolve(ROOT, path.dirname(fromFile), spec)
      : null;
  if (base === null) return null; // a package, not ours

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return path.relative(ROOT, candidate);
    }
  }
  return null;
}

/**
 * Every edge out of a module: what it imports or re-exports, and under which
 * names.
 *
 * `namespace` marks an edge that names nothing — `import * as`, `export * from`
 * or a dynamic `import()`. A module on the far side of one cannot be checked
 * for unused exports at all, because the importer never spells them out. That
 * is how `db/schema` is covered without a special case: `db/schema/index.ts`
 * re-exports each table file wholesale, and `db/client.ts` takes the barrel as
 * a namespace.
 *
 * `typeOnly` is the `import type` form, which the bundler erases.
 */
export function moduleEdges(file) {
  const contents = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
  const edges = [];

  for (const match of contents.matchAll(/(?:^|\n)\s*(import|export)\s+([^;]*?)from\s*'([^']+)'/g)) {
    const [, keyword, clause, spec] = match;
    const trimmed = clause.trim();

    if (/^\*/.test(trimmed)) {
      edges.push({ kind: keyword, spec, names: [], namespace: true, typeOnly: false });
      continue;
    }

    const typeOnly = /^type\s/.test(trimmed);
    const names = [];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '');
        if (name) names.push(name.split(/\s+as\s+/)[0].trim());
      }
    }
    // A default or namespace binding sits outside the braces.
    const outside = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/^\s*type\s+/, '')
      .split(',')[0]
      .trim();
    if (outside && /^[A-Za-z0-9_$]+$/.test(outside)) names.push('default');

    edges.push({ kind: keyword, spec, names, namespace: false, typeOnly });
  }

  for (const match of contents.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)) {
    edges.push({ kind: 'import', spec: match[1], names: [], namespace: true, typeOnly: false });
  }

  return edges;
}

/** The `'use client'` / `'use server'` directive a module declares, or null. */
export function directiveOf(file) {
  const head = stripComments(readFileSync(path.join(ROOT, file), 'utf8')).trimStart();
  if (/^['"]use client['"]/.test(head)) return 'client';
  if (/^['"]use server['"]/.test(head)) return 'server';
  return null;
}

/**
 * The members of the `JobType` union in lib/queue/index.ts, or null when the
 * union cannot be found. Shared by the two rules that hold other files to it,
 * so they cannot disagree about which job types exist.
 */
export function jobTypes() {
  const union = read('lib/queue/index.ts').match(/export type JobType =([\s\S]*?);/);
  return union ? [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : null;
}

/**
 * A guard for checks that pass by finding nothing.
 *
 * Most rules here select files or declarations with a pattern and then fail on
 * what they find. When the codebase moves under the pattern — a file renamed,
 * a declaration reshaped — the selection comes back empty and the rule reports
 * success forever. env-parity has carried a floor like this since it was
 * written; the others that select by pattern get the same one. The floors sit
 * well below today's counts on purpose: they catch a parser that has stopped
 * matching, not ordinary growth or pruning.
 */
export function requireAtLeast(rule, where, count, floor, what) {
  if (count >= floor) return true;
  fail(
    rule,
    where,
    `found only ${count} ${what} (expected at least ${floor}) — the pattern this check selects with is out of date with the code, so it is passing by checking nothing`,
  );
  return false;
}
