#!/usr/bin/env node
/**
 * The rules from AGENTS.md that a machine can check, checked by a machine.
 *
 * Everything here used to be a sentence asking a human or an agent to remember
 * something across a whole session — "declare the variable in render.yaml too",
 * "register the handler", "never read shipments.data from a page". Those are
 * exactly the instructions that get followed for a month and then missed once,
 * and several of them have already been missed once: §6.38 (the tracking payload
 * that must not reach a public page), §6.26 and §6.29 (3,888 Instagram
 * deliveries lost to a credential nobody had declared in two places).
 *
 * A rule that lives only in prose is enforced by whoever last read the prose.
 * A rule here is enforced on every pull request.
 *
 * Every check runs even after one fails, and every violation is printed — an
 * agent fixing these gets the whole list in one pass instead of one item per
 * push. Each rule carries the reason it exists, because a check whose purpose
 * nobody remembers gets deleted the first time it is inconvenient.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, readlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const failures = [];

/** Records a violation. `where` is a path (plus optional :line) for the reader. */
function fail(rule, where, message) {
  failures.push({ rule, where, message });
}

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Every file git actually tracks, which is the right population for these rules:
 * a build artefact or a local .env sitting in the working tree is not the
 * repository's problem, and node_modules would swamp every scan below.
 */
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const trackedSource = tracked.filter((f) => /\.(ts|tsx|mts|mjs)$/.test(f));

/**
 * The checks themselves are not application code and are never scanned.
 *
 * A checker necessarily contains the patterns it looks for. This file holds the
 * literal `from 'sanitize-html'` it searches for, and db-invariants.sql raises
 * an exception whose message says FORCE ROW LEVEL SECURITY — so scanning
 * scripts/ci reports every rule as violated by the rule.
 *
 * Excluded here, once, rather than by a special case inside each check: the next
 * rule added would otherwise flag itself the first time it runs on a branch
 * where these files are tracked. That is exactly how this was found — the checks
 * passed while the files were still untracked and failed the moment they were
 * committed.
 */
const CHECKER_PREFIX = 'scripts/ci/';
const scannable = tracked.filter((f) => !f.startsWith(CHECKER_PREFIX));
const scannableSource = trackedSource.filter((f) => !f.startsWith(CHECKER_PREFIX));

/** Line number of the first match, for an error message that points somewhere. */
function lineOf(contents, index) {
  return contents.slice(0, index).split('\n').length;
}

/**
 * Comments blanked, newlines kept so line numbers still point at the source.
 *
 * This codebase explains its rules in prose next to the code that follows them —
 * `platform.ts` spends a paragraph on why `events[0]` is meaningless. Scanning
 * raw text reports those paragraphs as violations of the rule they describe.
 */
function stripComments(contents) {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

function scan(files, pattern, onMatch) {
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
function resolveModule(spec, fromFile) {
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
function moduleEdges(file) {
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
function directiveOf(file) {
  const head = stripComments(readFileSync(path.join(ROOT, file), 'utf8')).trimStart();
  if (/^['"]use client['"]/.test(head)) return 'client';
  if (/^['"]use server['"]/.test(head)) return 'server';
  return null;
}

// ---------------------------------------------------------------------------
// Environment variables: lib/env.ts and render.yaml describe the same system
//
// AGENTS.md: "Environment variables are declared in lib/env.ts (Zod, parsed
// lazily) and in render.yaml in the same commit."
//
// The failure this prevents is not a build error, it is a silent one. A variable
// the code reads and the blueprint never mentions is a variable nobody sets on
// the new environment, and the symptom arrives later as a channel that stopped
// working. INSTAGRAM_APP_SECRET is the worked example: unset, every Instagram
// delivery is answered 403 and the log blames a forgery.
// ---------------------------------------------------------------------------
function checkEnvParity() {
  const rule = 'env-parity';
  const envTs = read('lib/env.ts');
  const renderYaml = read('render.yaml');

  // The schema block only — helper functions below it name the same variables
  // and would otherwise read as declarations.
  const schemaStart = envTs.indexOf('const schema = z.object({');
  const schemaEnd = envTs.indexOf('export type Env');
  const schema = envTs.slice(schemaStart, schemaEnd);

  const declared = [...schema.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s/gm)].map((m) => m[1]);

  if (declared.length < 20) {
    fail(
      rule,
      'lib/env.ts',
      `only parsed ${declared.length} keys out of the Zod schema — the parser above is out of date with the file's shape`,
    );
    return;
  }

  /**
   * Set by the platform rather than by us, so they are not in the Zod schema and
   * must not be reported as undeclared when render.yaml sets them.
   */
  const platformOwned = new Set(['NODE_VERSION', 'NODE_ENV', 'PORT']);

  for (const key of declared) {
    // A key counts as present whether render.yaml declares it (`- key: X`) or
    // lists it in a group's dashboard-owned comment. Both are deliberate: a
    // group cannot carry a secret's value, so the comment *is* the declaration.
    // See the note at the top of render.yaml.
    if (!new RegExp(`\\b${key}\\b`).test(renderYaml)) {
      fail(
        rule,
        'render.yaml',
        `${key} is declared in lib/env.ts but never mentioned in render.yaml — add it to a group's key list or its dashboard-owned comment`,
      );
    }
  }

  const inYaml = [...renderYaml.matchAll(/^\s*-?\s*key:\s*([A-Z][A-Z0-9_]*)/gm)].map((m) => m[1]);
  for (const key of new Set(inYaml)) {
    if (platformOwned.has(key)) continue;
    // A per-account WhatsApp credential is named by a database row, so it cannot
    // be in the schema — but the name must still start WHATSAPP_TOKEN_, which is
    // what stops an admin choosing which secret gets sent to Meta as a bearer
    // token (lib/whatsapp/accounts.ts).
    if (key.startsWith('WHATSAPP_TOKEN_')) continue;
    if (!declared.includes(key)) {
      fail(
        rule,
        'render.yaml',
        `${key} is set by render.yaml but not declared in lib/env.ts — every variable the system reads belongs in the schema`,
      );
    }
  }
}

/**
 * render.yaml must not become the place a secret lives.
 *
 * Two separate rules, both already written down and both easy to break by
 * copying a nearby line:
 *
 *   - `sync: false` is not allowed inside an environment group. Render's
 *     blueprint reference rules it out, and a group entry needs either a literal
 *     value or `generateValue` — so a group's dashboard-owned keys are listed as
 *     a comment instead.
 *   - A key declared in more than one group is the trap without the precedence
 *     rule to settle it. Render gives service-level variables precedence over
 *     group values; two groups linked by one service have no such tiebreak.
 */
function checkRenderGroups() {
  const rule = 'render-groups';
  const lines = read('render.yaml').split('\n');

  /**
   * render.yaml as a list of `- name:` blocks.
   *
   * Both env groups and services are written that way, and they are told apart
   * by what is inside: a service declares `type:`, a group does not. Parsing by
   * indentation rather than by a YAML library keeps this script dependency-free
   * — the blueprint is hand-written and its shape is stable.
   */
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)-\s*name:\s*(.+?)\s*$/);
    if (!open) continue;
    const indent = open[1].length;

    // Which list this entry belongs to — the nearest key above it at a
    // shallower indent. `envVarGroups:` makes it a group, `services:` a service;
    // `projects:` and `environments:` entries are neither and are skipped, which
    // is what stops a project block from swallowing the services nested in it.
    let section = null;
    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j];
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      const at = line.search(/\S/);
      if (at < indent && /^\s*[A-Za-z]+:\s*$/.test(line)) {
        section = line.trim().replace(':', '');
        break;
      }
    }
    if (section !== 'envVarGroups' && section !== 'services') continue;

    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const at = line.search(/\S/);
      if (at <= indent) break;
      body.push([j, line]);
    }
    blocks.push({
      name: open[2].replace(/^['"]|['"]$/g, ''),
      kind: section === 'envVarGroups' ? 'group' : 'service',
      body,
    });
  }

  const groups = new Map();
  const services = [];

  for (const block of blocks) {
    if (block.kind === 'service') {
      services.push({
        name: block.name,
        linked: block.body
          .map(([, l]) => l.match(/^\s*-\s*fromGroup:\s*(\S+)/))
          .filter(Boolean)
          .map((m) => m[1]),
      });
      continue;
    }

    const keys = new Map();
    for (let k = 0; k < block.body.length; k++) {
      const [lineNo, line] = block.body[k];
      const key = line.match(/^\s*-\s*key:\s*([A-Z][A-Z0-9_]*)/);
      if (!key) continue;
      keys.set(key[1], lineNo + 1);

      // `sync: false` is not allowed inside an environment group: Render's
      // blueprint reference rules it out, and a group entry needs either a
      // literal value or `generateValue`. A literal would put the secret in the
      // repo and `value: ''` would blank the real one on the next sync, so a
      // group's dashboard-owned keys are listed as a comment instead.
      const rest = block.body
        .slice(k + 1, k + 4)
        .map(([, l]) => l)
        .join('\n');
      if (/^\s*sync:\s*false/m.test(rest)) {
        fail(
          rule,
          `render.yaml:${lineNo + 1}`,
          `${key[1]} uses \`sync: false\` inside env group ${block.name} — Render does not allow it in a group; list the key in the group's dashboard-owned comment instead`,
        );
      }
    }
    if (keys.size > 0 || /envVars:/.test(block.body.map(([, l]) => l).join('\n'))) {
      groups.set(block.name, keys);
    }
  }

  /**
   * A key declared in two groups is only a problem when one service links both.
   *
   * Production and staging deliberately declare EMAIL_PROVIDER differently —
   * that is the whole point of splitting them, and nothing links both. What has
   * no tiebreak is two groups linked by the *same* service: Render's precedence
   * rule settles a service value against a group value, and says nothing about
   * one group against another.
   */
  for (const service of services) {
    const seen = new Map();
    for (const groupName of service.linked) {
      for (const key of groups.get(groupName)?.keys() ?? []) {
        const already = seen.get(key);
        if (already) {
          fail(
            rule,
            'render.yaml',
            `${key} is declared in both ${already} and ${groupName}, and service ${service.name} links both — which value wins is undefined; declare it in exactly one`,
          );
        }
        seen.set(key, groupName);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The job registry
//
// AGENTS.md: "add the type to JobType in lib/queue/index.ts, a handler under
// worker/handlers/, and register it in worker/handlers/index.ts — an
// unregistered type fails loudly rather than being dropped."
//
// Failing loudly is the right runtime behaviour and it is still a job that died
// in production. The registry is a closed set known at build time, so the
// mismatch can be caught here instead.
//
// The third check is the one prose never covered: a Render cron that runs
// `npm run job -- <type>` for a type that does not exist. That is a cron service
// going red on a schedule, discovered whenever somebody next reads the dashboard.
// ---------------------------------------------------------------------------
function checkJobRegistry() {
  const rule = 'job-registry';
  const queue = read('lib/queue/index.ts');
  const registry = read('worker/handlers/index.ts');

  const union = queue.match(/export type JobType =([\s\S]*?);/);
  if (!union) {
    fail(rule, 'lib/queue/index.ts', 'could not find the JobType union');
    return;
  }
  const types = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (
    !requireAtLeast(rule, 'lib/queue/index.ts', types.length, 10, 'job types in the JobType union')
  ) {
    return;
  }

  const handlersBlock = registry.match(
    /export const handlers: Partial<Record<JobType, JobHandler>> = \{([\s\S]*?)\n\};/,
  );
  if (!handlersBlock) {
    fail(rule, 'worker/handlers/index.ts', 'could not find the handlers map');
    return;
  }
  // Both `cleanup,` (shorthand) and `sla_sweep: () => ...` are registrations.
  const registered = [...handlersBlock[1].matchAll(/^\s{2}([a-z_]+)\s*[:,]/gm)].map((m) => m[1]);
  if (
    !requireAtLeast(rule, 'worker/handlers/index.ts', registered.length, 10, 'registered handlers')
  ) {
    return;
  }

  const plannedBlock = registry.match(/PLANNED_JOB_TYPES = new Set<JobType>\(\[([\s\S]*?)\]\)/);
  const planned = plannedBlock
    ? [...plannedBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    : [];

  for (const type of types) {
    if (!registered.includes(type) && !planned.includes(type)) {
      fail(
        rule,
        'worker/handlers/index.ts',
        `job type "${type}" has no handler and is not in PLANNED_JOB_TYPES — every enqueued job of this type will fail`,
      );
    }
  }
  for (const name of registered) {
    if (!types.includes(name)) {
      fail(
        rule,
        'worker/handlers/index.ts',
        `handler "${name}" is registered but is not a JobType — a rename left this behind`,
      );
    }
  }

  // Every cron in the blueprint has to name a job that exists.
  const yaml = read('render.yaml');
  for (const match of yaml.matchAll(/npm run job -- ([a-z_]+)/g)) {
    if (!types.includes(match[1])) {
      fail(
        rule,
        'render.yaml',
        `a cron runs \`npm run job -- ${match[1]}\`, which is not a JobType — that cron fails on every schedule`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// SQL that Drizzle does not write
//
// db/sql/*.sql is replayed after every migration, so each file has to survive
// being run again — and db/migrate.ts sends each file as one implicit
// transaction, which CREATE INDEX CONCURRENTLY cannot run inside.
//
// The database job in CI proves idempotency by actually replaying these files.
// These checks are the cheap half: they name the offending line instead of
// handing back a Postgres error from the middle of a 500-line file.
// ---------------------------------------------------------------------------
function checkPostMigrationSql() {
  const rule = 'db-sql';
  const dir = path.join(ROOT, 'db/sql');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));

  for (const file of files) {
    const rel = `db/sql/${file}`;
    const contents = readFileSync(path.join(dir, file), 'utf8');
    // Comments explain these rules in place; stripping them keeps the prose from
    // matching as if it were a statement.
    const code = contents.replace(/--[^\n]*/g, '');

    for (const match of code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/gi)) {
      fail(
        rule,
        `${rel}:${lineOf(code, match.index)}`,
        'CREATE INDEX CONCURRENTLY cannot run inside a transaction, and db/migrate.ts sends each file as one',
      );
    }

    for (const match of code.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY|IF\s+NOT\s+EXISTS)/gi,
    )) {
      fail(
        rule,
        `${rel}:${lineOf(code, match.index)}`,
        'CREATE INDEX without IF NOT EXISTS — this file is replayed after every migration and must be idempotent',
      );
    }
    for (const match of code.matchAll(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi)) {
      fail(
        rule,
        `${rel}:${lineOf(code, match.index)}`,
        'CREATE TABLE without IF NOT EXISTS — and a table belongs in db/schema/ plus a generated migration, not here',
      );
    }
    for (const match of code.matchAll(/CREATE\s+FUNCTION\s/gi)) {
      fail(
        rule,
        `${rel}:${lineOf(code, match.index)}`,
        'CREATE FUNCTION without OR REPLACE — this file is replayed after every migration',
      );
    }
    for (const match of code.matchAll(/CREATE\s+EXTENSION\s+(?!IF\s+NOT\s+EXISTS)/gi)) {
      fail(rule, `${rel}:${lineOf(code, match.index)}`, 'CREATE EXTENSION without IF NOT EXISTS');
    }
  }

  /**
   * RLS is enabled by a loop over `public`, deliberately, because a list has the
   * same gap one table later — seven tables reached production readable and
   * writable with the anon key that ships in client bundles. A hand-written
   * ALTER TABLE ... ENABLE ROW LEVEL SECURITY means somebody has started
   * maintaining that list again.
   */
  for (const file of files) {
    const contents = readFileSync(path.join(dir, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const match of contents.matchAll(
      /ALTER\s+TABLE\s+(?!public\.%I)[^\n;]*ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    )) {
      fail(
        rule,
        `db/sql/${file}:${lineOf(contents, match.index)}`,
        'RLS is enabled by the loop over public in db/sql — do not enable it table by table, a list has the same gap one table later',
      );
    }
  }
}

/**
 * FORCE row level security, anywhere.
 *
 * The app connects as the table owner, which bypasses RLS — that is what makes
 * an enabled-but-policy-less table readable by the app and closed to everyone
 * else. FORCE removes the owner's bypass and every query in the system starts
 * returning nothing. It is the one rule in AGENTS.md whose blast radius is the
 * whole product, and it is a single word.
 */
function checkNoForceRls() {
  scan(
    scannable.filter((f) => /\.(sql|ts|tsx)$/.test(f)),
    /FORCE\s+ROW\s+LEVEL\s+SECURITY/gi,
    (file, line) => {
      fail(
        'force-rls',
        `${file}:${line}`,
        'FORCE ROW LEVEL SECURITY — the app connects as the table owner, so this breaks every query in the system',
      );
    },
  );
}

// ---------------------------------------------------------------------------
// The delivery platform's payload
//
// The tracking endpoint's ?pin= is not checked, so a tracking number is the only
// credential guarding the recipient's name, address, phone and COD amount. The
// payload therefore lands only in shipments.data, and exactly one module reads
// it back out — lib/shipments/detail.ts — which builds a fresh object from a
// named field list rather than spreading what it was given.
//
// A page picking its own fields off `data` makes the privacy promise only as
// good as the newest page, and /help/<locale>/track makes that promise in
// writing. This is §6.38.
// ---------------------------------------------------------------------------
function checkShipmentPayloadConfinement() {
  const rule = 'shipment-payload';

  /**
   * lookup.ts selects the column and hands it straight to detail.ts without
   * looking inside it; sync.ts writes it; platform.ts produces it. Everything
   * else goes through publicTracking() or agentTracking().
   */
  const allowed = new Set([
    'lib/shipments/detail.ts',
    'lib/shipments/lookup.ts',
    'lib/shipments/sync.ts',
    'lib/shipments/platform.ts',
  ]);

  const candidates = scannableSource.filter((f) => !allowed.has(f) && !f.endsWith('.test.ts'));

  scan(candidates, /\bshipments\.data\b/g, (file, line) => {
    fail(
      rule,
      `${file}:${line}`,
      'reads shipments.data directly — go through publicTracking() or agentTracking() in lib/shipments/detail.ts, which build a fresh object from a named field list',
    );
  });

  // The public shape must never grow a passthrough field. A `data` on
  // PublicTracking publishes the whole payload on a page anybody can open.
  const detail = read('lib/shipments/detail.ts');
  const publicType = detail.match(/export type PublicTracking = \{([\s\S]*?)\n\};/);
  if (!publicType) {
    fail(rule, 'lib/shipments/detail.ts', 'could not find the PublicTracking type');
  } else if (/^\s{2}(data|raw|payload|order)[?]?:/m.test(publicType[1])) {
    fail(
      rule,
      'lib/shipments/detail.ts',
      "PublicTracking has a passthrough field — the public tracking page would publish the recipient's name, address, phone and COD amount (§6.38)",
    );
  }

  /**
   * tracking_events arrive in no order at all, so nothing may treat a position
   * in the array as "latest". mapDeliveryOrder owns the ordering rules.
   */
  scan(
    scannableSource.filter(
      (f) =>
        f.includes('shipment') &&
        !f.endsWith('.test.ts') &&
        // platform.ts is the module that owns the ordering rule: `readEvents`
        // sorts by instant and `statusInstant` then reads the sorted array on
        // purpose. It is the one place allowed to index, because it is the only
        // place that has already sorted.
        f !== 'lib/shipments/platform.ts',
    ),
    /\bevents\s*\[\s*0\s*\]|\bevents\.at\(\s*-1\s*\)|\bevents\[events\.length\s*-\s*1\]/g,
    (file, line) => {
      fail(
        rule,
        `${file}:${line}`,
        'indexes into tracking events — the platform sends them in no order at all, so neither the first nor the last element is the latest',
      );
    },
  );
}

// ---------------------------------------------------------------------------
// Source conventions that are one grep away from being enforced
// ---------------------------------------------------------------------------

/**
 * Where a server action may live: `actions.ts`, or a `<domain>-actions.ts`
 * sibling, anywhere under app/.
 *
 * The second spelling is not hypothetical. `admin/settings-actions.ts` has used
 * it since it was written, and the first version of this check matched only
 * `actions.ts`, so that file's directive was never checked. Deleting it was
 * still caught, but only by accident: client-bundle fired because the admin
 * forms that import the file then reached `db/schema`, and it said so in terms
 * of the bundle rather than the directive. An action file no client form
 * imports would have gone through clean. `plans/refactor-in-stages.md` splits
 * the two large action files into more `*-actions.ts` siblings, which would
 * have widened that gap one file at a time.
 */
const ACTION_FILE = /^app\/(?:.*\/)?(?:[a-z0-9-]+-)?actions\.ts$/;

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
function requireAtLeast(rule, where, count, floor, what) {
  if (count >= floor) return true;
  fail(
    rule,
    where,
    `found only ${count} ${what} (expected at least ${floor}) — the pattern this check selects with is out of date with the code, so it is passing by checking nothing`,
  );
  return false;
}

/**
 * Two directions, because either half alone leaves an endpoint nobody reviews.
 *
 * Every export of a `'use server'` module is published by Next as a POST
 * endpoint anyone can call with any arguments. That is why AGENTS.md asks every
 * action to authorise and to re-read ids rather than trust them — and a reviewer
 * applies that scrutiny to files that look like actions. So:
 *
 * - an action file must carry the directive, or it is not what its name says;
 * - a module that carries the directive must be named as an action file, and a
 *   `'use server'` anywhere else — a lib/ helper, or one inlined into a page's
 *   function body — fails, because it publishes endpoints from a file nobody
 *   reads as a list of endpoints.
 *
 * `lib/automations/actions.ts` shares the name and is not a server action: it is
 * the automation engine's rule actions. The first direction is scoped to app/ so
 * it is left alone, and the second would catch it the day it grew a directive.
 */
function checkServerActions() {
  const rule = 'server-actions';

  const actionFiles = tracked.filter((f) => ACTION_FILE.test(f));
  if (!requireAtLeast(rule, 'app/', actionFiles.length, 5, 'server action files')) return;

  for (const file of actionFiles) {
    if (directiveOf(file) !== 'server') {
      fail(rule, file, "a server action file must start with 'use server'");
    }
  }

  scan(
    scannableSource.filter((f) => /\.tsx?$/.test(f)),
    /['"]use server['"]/g,
    (file, line, match, contents) => {
      // `contents` has its comments blanked, so a directive written below a
      // header comment still starts at the first non-whitespace character.
      const isFileDirective = match.index === contents.length - contents.trimStart().length;
      if (isFileDirective && ACTION_FILE.test(file)) return;
      fail(
        rule,
        `${file}:${line}`,
        isFileDirective
          ? "a 'use server' module must be named actions.ts or <domain>-actions.ts under app/ — every export of it is a public POST endpoint, and reviewers look for those in action files"
          : "an inline 'use server' publishes a POST endpoint from inside another file — move the action into an actions.ts beside it",
      );
    },
  );
}

/**
 * Sanitising is done on write, never on read, through one module.
 *
 * Email bodies and imported KB HTML are attacker-controlled. A second call site
 * is how "sanitise on write" quietly becomes "sanitise wherever somebody
 * remembered", and a sanitiser configured twice is a sanitiser configured
 * differently in two places.
 */
function checkSanitiserConfinement() {
  scan(
    scannableSource.filter((f) => f !== 'lib/html/sanitize.ts'),
    /from 'sanitize-html'|require\('sanitize-html'\)/g,
    (file, line) => {
      fail(
        'sanitiser',
        `${file}:${line}`,
        'imports sanitize-html directly — go through lib/html/sanitize.ts, which is the one place the policy is configured',
      );
    },
  );
}

/**
 * An article body that is sanitised on write is also normalised on write.
 *
 * The two belong together and in that order: `sanitiseArticleHtml` is the
 * security boundary and `normaliseArticleHtml` is the formatting standard the
 * help centre's stylesheet assumes. A write path that sanitises and forgets to
 * normalise stores an article carrying whatever the author's clipboard brought
 * with it — four editors' classes, inline colours that override the article
 * palette, and body `h1`s that render as plain text — and nothing downstream
 * notices, because the page renders the row it is given.
 *
 * Checked as a pair rather than by asking for the call, because the ordering is
 * the part that is easy to get wrong and impossible to see later.
 */
function checkArticleNormalisation() {
  for (const file of scannableSource) {
    if (file === 'lib/kb/format.ts' || file.endsWith('.test.ts')) continue;

    const source = read(file);
    if (!source.includes('sanitiseArticleHtml(')) continue;
    if (file === 'lib/html/sanitize.ts') continue;

    if (!source.includes('normaliseArticleHtml(')) {
      fail(
        'article-normalisation',
        file,
        'sanitises an article body but never normalises it — wrap the call as ' +
          'normaliseArticleHtml(sanitiseArticleHtml(html)); lib/kb/format.ts says why',
      );
      continue;
    }

    for (const match of source.matchAll(/sanitiseArticleHtml\(([^)]*)\)/g)) {
      const before = source.slice(0, match.index);
      const wrapped = /normaliseArticleHtml\(\s*$/.test(before);
      if (!wrapped) {
        fail(
          'article-normalisation',
          `${file}:${before.split('\n').length}`,
          'sanitises an article body outside normaliseArticleHtml(...) — normalising ' +
            'first would hand the sanitiser markup this repo had already rewritten',
        );
      }
    }
  }
}

/**
 * ASCII slugify erases Arabic entirely, and Arabic is the default locale and the
 * front door. lib/kb/slug.ts is the one implementation that handles it.
 */
function checkSlugConfinement() {
  scan(
    scannableSource.filter((f) => !f.startsWith('lib/kb/slug')),
    /\.replace\([^)]*\[\^a-z0-9\][^)]*\)/gi,
    (file, line) => {
      fail(
        'slugify',
        `${file}:${line}`,
        'looks like an ASCII slugify, which erases Arabic entirely — use slugify() from lib/kb/slug.ts',
      );
    },
  );
}

/**
 * `title=` on a DOM element never appears on a phone, which is where the console
 * is read. components/tooltip.tsx answers hover, focus and tap alike.
 *
 * Only lowercase JSX elements are DOM elements — `<Section title="...">` is a
 * component prop and perfectly fine.
 */
function checkNoDomTitleAttribute() {
  /**
   * Three uses that predate this check and are not mechanical swaps.
   *
   * `Tooltip` renders its trigger as a real button, which is what makes it
   * answer a tap. That is the right shape for a span of text and the wrong shape
   * for these: `availability.tsx` would nest a button inside the submit button
   * it describes, and the other two would turn a layout element — an avatar
   * circle, a channel badge — into a control. Each needs a design decision about
   * what the trigger should be, not a find and replace, so they are named here
   * rather than silently rewritten or the rule dropped.
   *
   * Anything not on this list fails. Do not extend it — fix the call site.
   */
  const predating = new Set([
    'app/(console)/availability.tsx',
    'app/(console)/layout.tsx',
    'components/channel.tsx',
  ]);

  scan(
    scannable.filter((f) => f.endsWith('.tsx') && !predating.has(f)),
    /<[a-z][a-zA-Z0-9]*(?:\s+[^<>]*?)?\stitle=/g,
    (file, line) => {
      fail(
        'dom-title',
        `${file}:${line}`,
        'title= on a DOM element never appears on a phone — use Tooltip or InfoTip from components/tooltip.tsx',
      );
    },
  );
}

/**
 * A console page brings its own scroll container (§6.53).
 *
 * The shell in `app/(console)/layout.tsx` is `h-dvh overflow-hidden` with a
 * `min-h-0 flex-1` content column, so that the inbox can own the full height and
 * manage its own panes. The price is that a page which does not open an
 * `overflow-y-auto` wrapper is not merely unpadded: everything below the fold is
 * rendered where nobody can scroll to it, and the page reads as half-finished
 * rather than broken. `/reports/categories` shipped that way and was caught by a
 * person; the four `/contacts` pages shipped that way and were caught by an
 * audit reading the code, which is the reason this is now a check.
 *
 * Two things satisfy it, and neither is a list of exempt files. `admin/` pages
 * get the wrapper from `admin/layout.tsx`, so they are not scanned. And a page
 * that renders `<InboxShell>` is handing the height to the one component that
 * lays out its own panes — the inbox list and the ticket view scroll inside
 * those. Anything else must say `overflow-y-auto` itself.
 */
function checkConsolePagesScroll() {
  const rule = 'console-scroll';

  const pages = scannable.filter(
    (f) => /^app\/\(console\)\/.*page\.tsx$/.test(f) && !f.startsWith('app/(console)/admin/'),
  );
  if (!requireAtLeast(rule, 'app/(console)/', pages.length, 8, 'console pages outside admin/')) {
    return;
  }

  for (const page of pages) {
    const contents = stripComments(read(page));
    if (/\boverflow-y-auto\b/.test(contents) || /<InboxShell\b/.test(contents)) continue;
    fail(
      rule,
      page,
      'no scroll container — the console shell clips its content column, so everything below the fold is unreachable; wrap the page in `app-scroll h-full overflow-y-auto p-6` (AGENTS.md, §6.53)',
    );
  }
}

/**
 * One palette. The app is light-only, everywhere, whatever the reader's
 * operating system asks for.
 *
 * This is a check rather than a sentence because a dark theme comes back one
 * utility at a time. A dark-variant colour appended to a class list is
 * invisible in review — it is a colour nobody looking at the page can see — and
 * the moment the first `@media (prefers-color-scheme: dark)` block returns,
 * every one of them wakes up at once against tokens that were never re-stepped
 * for a dark surface. Half a theme is worse than none: light text on the light
 * `--surface` that is still what `:root` resolves to.
 *
 * Note the phrasing above: this file is scanned by Tailwind like any other, so
 * spelling a complete variant class in a comment here — even to explain why it
 * is banned — emits that utility into the served stylesheet.
 *
 * Three things, then. No media query answering the OS preference, no Tailwind
 * `dark:` variant (which is that same media query spelled shorter), and the
 * `color-scheme: light` that pins the surfaces the browser paints itself — a
 * select's dropdown, the form-control chrome, the default scrollbar. That
 * declaration is the only part a stylesheet cannot express by omission, so its
 * absence is a failure rather than a preference.
 *
 * If a dark theme is ever wanted, it is a piece of work — re-step the tokens,
 * decide whether the help centre follows the console, check the chart series
 * against the new surfaces — and this rule comes out in that commit.
 */
function checkLightOnly() {
  const rule = 'light-only';

  // CSS comments carry the reasoning, including the words below. Blanked the
  // same way stripComments blanks a JS comment, newlines kept so a line number
  // still points somewhere.
  const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  for (const file of scannable.filter((f) => f.endsWith('.css'))) {
    const css = stripCss(read(file));
    for (const match of css.matchAll(/prefers-color-scheme/g)) {
      fail(
        rule,
        `${file}:${lineOf(css, match.index)}`,
        'the app is light-only — a dark block here re-enables half a theme against tokens stated for light surfaces',
      );
    }
  }

  scan(scannableSource, /(?:^|[\s'"`{(])dark:[a-z[]/g, (file, line) => {
    fail(
      rule,
      `${file}:${line}`,
      "Tailwind's dark: variant is prefers-color-scheme by another name — drop the override and keep the light value",
    );
  });

  const globals = stripCss(read('app/globals.css'));
  if (!/:root\s*\{[^}]*color-scheme:\s*light/.test(globals)) {
    fail(
      rule,
      'app/globals.css',
      'color-scheme: light is gone from :root — the browser paints its own controls and scrollbars dark again on a light page',
    );
  }
}

/**
 * X-Frame-Options: DENY everywhere except /widget, which uses frame-ancestors
 * with an explicit allowlist. Dropping the blanket DENY makes the console
 * clickjackable, and it is one header in one file.
 */
function checkFramingHeaders() {
  const rule = 'framing';
  const config = read('next.config.ts');
  if (!/'X-Frame-Options',\s*value:\s*'DENY'/.test(config)) {
    fail(
      rule,
      'next.config.ts',
      'the blanket X-Frame-Options: DENY is gone — without it the console can be framed and clickjacked',
    );
  }
  if (!/frame-ancestors/.test(config)) {
    fail(
      rule,
      'next.config.ts',
      'the widget route no longer sets frame-ancestors, so its framing is unrestricted',
    );
  }
}

/**
 * Secrets never enter the repo, and .env files are local only.
 *
 * A tracked .env is the single most direct way this rule gets broken, and git
 * remembers it after the delete.
 */
function checkNoCommittedEnvFiles() {
  for (const file of tracked) {
    const base = path.basename(file);
    if (/^\.env($|\.)/.test(base) && base !== '.env.example') {
      fail(
        'secrets',
        file,
        'a .env file is committed — these are local only, and git remembers the value after it is deleted',
      );
    }
  }
}

/**
 * CLAUDE.md and .github/copilot-instructions.md are symlinks to AGENTS.md.
 *
 * Replacing one with a copy is silent and permanent: the copy stops being
 * updated, and the next agent reading it follows instructions that were correct
 * some months ago. AGENTS.md says a stale file is worse than none for exactly
 * this reason.
 */
function checkInstructionSymlinks() {
  const rule = 'agents-symlinks';
  for (const [link, target] of [
    ['CLAUDE.md', 'AGENTS.md'],
    ['.github/copilot-instructions.md', '../AGENTS.md'],
  ]) {
    const full = path.join(ROOT, link);
    if (!existsSync(full)) {
      fail(rule, link, 'is missing');
      continue;
    }
    if (!statSync(full, { throwIfNoEntry: false })?.isFile() || !isSymlink(full)) {
      fail(
        rule,
        link,
        `must be a symlink to ${target}, not a copy — a copy stops being updated and the next agent follows stale instructions`,
      );
      continue;
    }
    const actual = readlinkSync(full);
    if (actual !== target) {
      fail(rule, link, `points at ${actual}, expected ${target}`);
    }
  }
}

function isSymlink(full) {
  try {
    readlinkSync(full);
    return true;
  } catch {
    return false;
  }
}

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
function checkMigrationsNotHandEdited() {
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

/**
 * A form's built-in questions are named in four places and have to agree.
 *
 * `SYSTEM_KEYS` in lib/forms/elements.ts is the list the parser accepts; each of
 * the three screens that renders a form carries its own label map, because the
 * help centre labels are per-locale `StringKey`s and the two console screens are
 * plain English. Adding a key without the labels is not a type error where the
 * map is a `Record<SystemKey, …>` only in TypeScript's eyes — it *is* one, but
 * the failure a reviewer meets first is an admin placing a question that renders
 * with no label, on the one screen nobody opened while building it.
 *
 * Checked here rather than trusted to `tsc` because the maps are the kind of
 * thing a hurried edit turns into a `Record<string, …>` to make an error go
 * away, and then nothing is checking them at all.
 */
function checkFormSystemKeys() {
  const rule = 'form-system-keys';
  const source = read('lib/forms/elements.ts');

  const block = /export const SYSTEM_KEYS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block) {
    fail(rule, 'lib/forms/elements.ts', 'SYSTEM_KEYS is no longer a literal array this can read');
    return;
  }

  const keys = [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  if (keys.length === 0) {
    fail(rule, 'lib/forms/elements.ts', 'SYSTEM_KEYS parsed as empty');
    return;
  }

  // The console's new-ticket form deliberately has no map of its own: it uses
  // `SYSTEM_LABELS_EN` from elements.ts, which the server needs too. What is
  // left is the two that genuinely cannot share — the help centre's are
  // per-locale `StringKey`s, and the builder's name the audience each question
  // is for ("Their name (forms anybody can submit)").
  const renderers = [
    'lib/forms/elements.ts',
    'app/help/[locale]/forms/[slug]/form.tsx',
    'app/(console)/admin/forms/elements-builder.tsx',
  ];

  for (const file of renderers) {
    const labels = /SYSTEM_LABELS(?:_EN)?[^=]*=\s*\{([\s\S]*?)\n\};/.exec(read(file));
    if (!labels) {
      fail(rule, file, 'no SYSTEM_LABELS map found — a form question would render unlabelled');
      continue;
    }

    for (const key of keys) {
      if (!new RegExp(`\\b${key}\\s*:`).test(labels[1])) {
        fail(rule, file, `SYSTEM_LABELS is missing "${key}", which SYSTEM_KEYS accepts`);
      }
    }
  }
}

/**
 * Software answering is not an agent answering.
 *
 * The first-response metric is meant to say how long a person waited for a
 * person. Calling the SLA hook from an automated sender, or moving the column
 * the unanswered queue reads, lets an acknowledgement satisfy every target and
 * makes the queue claim somebody handled a ticket nobody has opened.
 */
function checkAutomatedRepliesDoNotCountAsAgentReplies() {
  const rule = 'automated-reply-boundary';
  const senders = ['lib/automations/index.ts', 'lib/auto-response/index.ts'];

  for (const file of senders) {
    const contents = stripComments(read(file));
    for (const match of contents.matchAll(/\bonAgentReply\s*\(/g)) {
      fail(
        rule,
        `${file}:${lineOf(contents, match.index)}`,
        'an automated sender must not stop an SLA response clock',
      );
    }
  }

  const outboundFile = 'lib/tickets/outbound.ts';
  const outbound = stripComments(read(outboundFile));
  for (const match of outbound.matchAll(/\b(lastAgentMessageAt|firstRespondedAt)\s*:/g)) {
    fail(
      rule,
      `${outboundFile}:${lineOf(outbound, match.index)}`,
      'automated delivery must leave the ticket in the unanswered queue',
    );
  }

  // `is_first_response_overdue` answers for the SLA, and only `firstRespondedAt`
  // does that. Reading the auto-reply stamp into it silences every rule sharing
  // the condition, including the escalations that send the customer nothing —
  // the loop belongs to the sender, and `alreadyReplied` guards it there.
  const factsFile = 'lib/rules/facts.ts';
  const facts = stripComments(read(factsFile));
  for (const match of facts.matchAll(
    /is_first_response_overdue[\s\S]{0,120}?firstAutoRepliedAt/g,
  )) {
    fail(
      rule,
      `${factsFile}:${lineOf(facts, match.index)}`,
      'the overdue flag answers for the SLA, not for whether software replied',
    );
  }

  // The other half: `firstAutoRepliedAt` exists so the rule engine can tell an
  // acknowledgement already went out. A report or the breach sweep reading it
  // would put the automation's latency back into the number this whole seam
  // exists to keep honest.
  for (const file of [
    'lib/reports/rollup.ts',
    'lib/reports/live.ts',
    'worker/handlers/sla-sweep.ts',
  ]) {
    const contents = stripComments(read(file));
    for (const match of contents.matchAll(/\b(firstAutoRepliedAt|first_auto_replied_at)\b/g)) {
      fail(
        rule,
        `${file}:${lineOf(contents, match.index)}`,
        'an automated reply is not a first response and must not reach a metric',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The browser bundle: no client component reaches the database, however
// indirectly
//
// AGENTS.md splits `lib/forms/files.ts` from `lib/forms/attachments.ts` by which
// side of the wire runs it, and `lib/kb/floors.ts` from `lib/kb/internal.ts` for
// the same reason. The first split had to be made because `node:fs` in the
// browser bundle is a build error. The second had no such backstop: three
// console components imported one label map from a module that value-imports
// `@/db/schema`, and Next shipped the whole Drizzle schema — 87 KB of table
// definitions no browser executes — in the first-load JS of `/kb/[id]`,
// `/kb/new` and `/kb/structure`. Nothing failed. Only a bundle report showed it.
//
// So the graph is walked here rather than trusted to review. A `'use client'`
// file is an entry point, and anything it can reach through a value import is
// in the bundle; `import type` is erased by tsc and is followed by nobody.
// ---------------------------------------------------------------------------
function checkClientBundleStaysOutOfTheDatabase() {
  const rule = 'client-bundle';

  /** `@/x` is the repo root, and a relative specifier is relative to the file. */
  /** The modules that must never be in a browser bundle, and why. */
  const FORBIDDEN = [
    ['db/schema', 'the Drizzle table definitions — 87 KB of SQL builders no browser runs'],
    ['db/client', 'the database pool'],
  ];

  const entries = scannableSource.filter(
    (file) => /\.tsx?$/.test(file) && directiveOf(file) === 'client',
  );
  if (!requireAtLeast(rule, 'app/', entries.length, 20, "'use client' entry points")) return;

  for (const entry of entries) {
    // Breadth-first, remembering how each module was reached: an error saying
    // "editor.tsx → lib/kb/internal.ts → db/schema" is fixable, and "something
    // in the console imports the schema" is not.
    const seen = new Set([entry]);
    const queue = [[entry]];

    while (queue.length > 0) {
      const trail = queue.shift();
      const file = trail[trail.length - 1];

      for (const edge of moduleEdges(file)) {
        // Imports only, and value imports only: `import type` is erased, and a
        // re-export is not something the entry pulls into its own bundle.
        if (edge.kind !== 'import' || edge.typeOnly) continue;
        const target = resolveModule(edge.spec, file);
        if (target === null || seen.has(target)) continue;
        seen.add(target);

        // A `'use server'` module is a boundary rather than a dependency: Next
        // replaces each export with a fetch to the server, so what it imports
        // never reaches the browser. Every client form in this repo imports its
        // own actions file, and following that edge would report the whole
        // console.
        if (directiveOf(target) === 'server') continue;

        const forbidden = FORBIDDEN.find(([prefix]) => target.startsWith(prefix));
        if (forbidden) {
          fail(
            rule,
            `${entry}`,
            `reaches ${forbidden[0]} — ${forbidden[1]} — via ${[...trail.slice(1), target].join(' → ') || target}; ` +
              'split the client-safe half into its own module, as lib/kb/floors.ts is split from lib/kb/internal.ts',
          );
          continue;
        }

        queue.push([...trail, target]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Exports nothing imports
//
// AGENTS.md: "When you learn something durable ... prefer a check in
// scripts/ci/repo-rules.mjs over a paragraph here."
//
// plans/query-optimisation-and-cleanup.md scanned for these by hand, found "a
// crude scan suggested 40", verified them one at a time, and asked for the
// check to be made mechanical so the next session would not redo the scan. It
// was redone anyway, and turned up twenty-seven: nine unused icons, a server
// action no form submits, and four functions whose doc comments described
// callers that do not exist — `onInboundMessage` called itself "the single call
// every inbound path makes" while no path made it.
//
// That last kind is why this is worth a check rather than a cleanup. Dead code
// costs nothing to execute; a dead function with a confident comment costs the
// next reader their afternoon, because it reads as the system's behaviour.
//
// **It asks the module graph, not the text.** The first version counted bare
// identifiers across the repo and called an export live if the token appeared
// anywhere else. That is not the question: `lib/portal/tickets.ts` exported a
// dead `contactName` that no file imported, and the count exempted it because
// `contactName` is an ordinary object key elsewhere — as `status`, `config`,
// `preview` and `handler` would be. A check that certifies a file clean while
// the defect is still in it is worse than no check, because §6.63 tells the
// next session the scan is mechanical. So an export is live when some other
// module names it in an `import` or a re-export, and nothing else counts.
//
// Values only — a function, const, class or enum. An exported *type* is not
// checked: annotating a return with a named exported type is good practice
// here, and the great majority of them are referenced only from the signature
// they describe, so flagging those would push the codebase to un-export shapes
// that callers legitimately need to name.
// ---------------------------------------------------------------------------

/**
 * Names the framework imports by calling convention rather than by reference,
 * each only in the kind of file the framework looks for it in.
 *
 * Scoping matters: `config`, `metadata` and `dynamic` are ordinary names for a
 * lib-level constant, and exempting them everywhere would hide real dead code
 * in exactly the modules this rule is most needed in.
 */
const ROUTE_HANDLERS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const SEGMENT_CONFIG = new Set([
  'generateStaticParams',
  'generateMetadata',
  'generateViewport',
  'metadata',
  'viewport',
  'dynamic',
  'dynamicParams',
  'revalidate',
  'runtime',
  'fetchCache',
  'preferredRegion',
  'maxDuration',
  'experimental_ppr',
]);

/** Next's own file names for a route segment. */
const SEGMENT_FILE =
  /(^|\/)(page|layout|route|template|default|loading|error|not-found|global-error)\.tsx?$/;

/** The entry points Next loads by path rather than by import. */
const FRAMEWORK_ENTRY = new Map([
  ['proxy.ts', new Set(['config', 'proxy', 'middleware'])],
  ['middleware.ts', new Set(['config', 'middleware'])],
  ['instrumentation.ts', new Set(['register', 'onRequestError'])],
]);

const VALUE_EXPORT =
  /^export\s+(?:async\s+)?(?:function\*?|const|let|var|abstract\s+class|class|enum)\s+([A-Za-z0-9_$]+)/gm;

function frameworkOwns(file, name) {
  if (FRAMEWORK_ENTRY.get(file)?.has(name)) return true;
  if (!file.startsWith('app/')) return false;
  if (/(^|\/)route\.tsx?$/.test(file) && ROUTE_HANDLERS.has(name)) return true;
  return SEGMENT_FILE.test(file) && SEGMENT_CONFIG.has(name);
}

function checkNoDeadExports() {
  const rule = 'dead-exports';

  const files = scannableSource.filter(
    (f) => /\.(ts|tsx|mts|mjs)$/.test(f) && !f.endsWith('.d.ts'),
  );
  if (!requireAtLeast(rule, '(repository)', files.length, 200, 'source modules')) return;

  // What every module has pulled out of every other, by name.
  const importedFrom = new Map();
  const opaque = new Set();

  for (const file of files) {
    for (const edge of moduleEdges(file)) {
      const target = resolveModule(edge.spec, file);
      if (target === null) continue;

      // Nothing can be said about a module reached without naming what it
      // exports — a namespace import, a wholesale re-export, a dynamic import.
      if (edge.namespace) {
        opaque.add(target);
        continue;
      }

      if (!importedFrom.has(target)) importedFrom.set(target, new Set());
      for (const name of edge.names) importedFrom.get(target).add(name);
    }
  }

  for (const file of files) {
    if (opaque.has(file)) continue;

    const contents = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
    const importers = importedFrom.get(file) ?? new Set();
    const isServerModule = directiveOf(file) === 'server';

    VALUE_EXPORT.lastIndex = 0;
    let match;
    while ((match = VALUE_EXPORT.exec(contents)) !== null) {
      const name = match[1];
      if (importers.has(name) || frameworkOwns(file, name)) continue;

      // Used in its own module and merely over-exported, which is a much
      // smaller thing than being uncalled — except in a `'use server'` file,
      // where an export is not a symbol at all: Next publishes each one as a
      // POST endpoint, so one nothing imports is a live route with no caller
      // and no page behind it. Nothing in this repo relies on that exemption
      // today; it exists so the rule does not demand a refactor of every module
      // that exports a helper it also uses.
      const usedHere = (contents.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length > 1;
      if (usedHere && !isServerModule) continue;

      fail(
        rule,
        `${file}:${lineOf(contents, match.index)}`,
        isServerModule
          ? `${name} is a server action nothing imports — Next still publishes it as a POST endpoint, so delete it or put it behind a form in the same commit`
          : `${name} is exported and no module imports it — delete it, or if it is a capability worth keeping, wire it up in the same commit`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

const RULES = [
  ['env-parity', checkEnvParity],
  ['render-groups', checkRenderGroups],
  ['job-registry', checkJobRegistry],
  ['db-sql', checkPostMigrationSql],
  ['force-rls', checkNoForceRls],
  ['shipment-payload', checkShipmentPayloadConfinement],
  ['server-actions', checkServerActions],
  ['sanitiser', checkSanitiserConfinement],
  ['article-normalisation', checkArticleNormalisation],
  ['slugify', checkSlugConfinement],
  ['dom-title', checkNoDomTitleAttribute],
  ['console-scroll', checkConsolePagesScroll],
  ['light-only', checkLightOnly],
  ['framing', checkFramingHeaders],
  ['secrets', checkNoCommittedEnvFiles],
  ['agents-symlinks', checkInstructionSymlinks],
  ['generated-files', checkMigrationsNotHandEdited],
  ['form-system-keys', checkFormSystemKeys],
  ['automated-reply-boundary', checkAutomatedRepliesDoNotCountAsAgentReplies],
  ['client-bundle', checkClientBundleStaysOutOfTheDatabase],
  ['dead-exports', checkNoDeadExports],
];

for (const [name, run] of RULES) {
  try {
    run();
  } catch (error) {
    fail(
      name,
      '(check itself)',
      `the check threw, which usually means the file it reads changed shape: ${error.message}`,
    );
  }
}

if (failures.length === 0) {
  console.log(`repo rules: ${RULES.length} checks, no violations.`);
  process.exit(0);
}

console.error(`\nrepo rules: ${failures.length} violation(s).\n`);
for (const { rule, where, message } of failures) {
  console.error(`  [${rule}] ${where}`);
  console.error(`      ${message}\n`);
}
console.error('Each of these is a rule from AGENTS.md. If one is wrong, change the rule');
console.error('in scripts/ci/repo-rules.mjs and say why in the same commit.\n');
process.exit(1);
