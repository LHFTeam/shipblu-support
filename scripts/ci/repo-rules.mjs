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

  const handlersBlock = registry.match(
    /export const handlers: Partial<Record<JobType, JobHandler>> = \{([\s\S]*?)\n\};/,
  );
  if (!handlersBlock) {
    fail(rule, 'worker/handlers/index.ts', 'could not find the handlers map');
    return;
  }
  // Both `cleanup,` (shorthand) and `sla_sweep: () => ...` are registrations.
  const registered = [...handlersBlock[1].matchAll(/^\s{2}([a-z_]+)\s*[:,]/gm)].map((m) => m[1]);

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
function checkServerActions() {
  const rule = 'server-actions';
  for (const file of tracked.filter((f) => /^app\/.*\/actions\.ts$/.test(f))) {
    const first = read(file)
      .split('\n')
      .find((l) => l.trim() !== '');
    if (!/^'use server';?$/.test(first?.trim() ?? '')) {
      fail(rule, file, "a server action file must start with 'use server'");
    }
  }
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
  ['light-only', checkLightOnly],
  ['framing', checkFramingHeaders],
  ['secrets', checkNoCommittedEnvFiles],
  ['agents-symlinks', checkInstructionSymlinks],
  ['generated-files', checkMigrationsNotHandEdited],
  ['form-system-keys', checkFormSystemKeys],
  ['automated-reply-boundary', checkAutomatedRepliesDoNotCountAsAgentReplies],
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
