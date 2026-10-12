import ts from 'typescript';
import { fail, read, scan, scannableSource, stripComments } from '../lib.mjs';

// ---------------------------------------------------------------------------
// The transaction-pooler pool
//
// postgres.js must never pipeline through Supavisor's transaction pooler
// (AGENTS.md, "postgres.js must never pipeline through the transaction
// pooler"). Once every connection is busy it writes the next query onto one
// still owed an answer, Supavisor v2.9 hands that backend back at the first
// ReadyForQuery and drops the replies after it, and each loss costs a
// connection until the process restarts — the 2026-10-11 freeze, §6.91 in
// docs/PROJECT-STATE.md.
//
// The admission gate in db/client.ts is what keeps postgres.js below that
// point, and it sits on `unsafe()` and `begin()`, the roads drizzle takes to
// the driver. A tagged template on the pool takes neither: it is not
// admitted, carries no deadline, and while the gate has every place filled it
// is exactly the query that lands on a busy connection. db/client.ts gates its
// own one by hand (`databaseProbe()`); anywhere else it would be gated by
// nobody. AGENTS.md asked for that in prose, which is enforced by whoever last
// read it, so the handles stay in that one file:
//
//  - `getSql`, the pool itself, named anywhere — an import, a call, or passed
//    along as a value;
//  - `$client`, drizzle's raw client, which `db` hands back as the same pool;
//  - `__shipbluSql`, the pool parked on globalThis across a dev reload;
//  - postgres.js loaded as a value, by any road — a static import or an
//    `export … from`, `import()`, `require()` or `import x = require()`, in
//    either quote and down any subpath (`postgres/cf/src/index.js` is the same
//    driver): a second pool on DATABASE_URL is ungated from the start, and its
//    connections are not counted against the gate's. A type-only import —
//    `import type`, every specifier marked `type`, `import('postgres').Sql` in
//    a type — is erased before anything runs, opens nothing, and passes.
//
// That last one is read from the syntax tree the TypeScript compiler builds,
// as dom-title is, and not from the text. It was a pattern for
// `from 'postgres'`, which saw neither a double-quoted import in a file
// Prettier does not format (an .mjs script) nor a subpath — each of them an
// ungated pool — and refused `import type { Sql }`, which opens nothing. In
// the tree a specifier is a string node whatever its quotes, a type-only
// import says so on the node, and a comment or a string that merely mentions
// the package (`serverExternalPackages: ['postgres']`) is not an import at all.
//
// Tests are left alone: they exercise the gate and the driver directly, on
// pools they open and close themselves. db/migrate.ts may open a pool of its
// own, and is named below with the reason.
//
// What it cannot see: `db._.session.client`, which drizzle types as a generic
// session and so needs a cast to reach — a cast a reviewer can see; and a
// specifier the code computes (`import(name)`), which no reading of the
// source can resolve.
// ---------------------------------------------------------------------------

const OWNER = 'db/client.ts';

/** Modules other than the owner that may import postgres.js, each with why. */
const POSTGRES_IMPORTERS = new Map([
  [
    'db/migrate.ts',
    'one connection (`max: 1`), statements awaited one at a time, on DATABASE_URL_SESSION when it is set, and run before the service starts — a pool with nothing to pipeline',
  ],
]);

const isTest = (file) => /\.test\.(ts|tsx|mts|mjs)$/.test(file);

/** `postgres` or any path inside it, however the literal was quoted. */
const isPostgresSpecifier = (node) =>
  node !== undefined &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
  /^postgres(\/|$)/.test(node.text);

/**
 * Whether `node` loads postgres.js as a value.
 *
 * A clause is type-only when it says `type` once for all of it, or names at
 * least one binding and marks every one of them `type`. An empty one —
 * `import {} from 'postgres'` — still loads the module, so it counts as a
 * value, as `import 'postgres'` does. `import('postgres').Sql` in a type is an
 * ImportTypeNode rather than a call, which is how it passes without this
 * function having to guess where types end and values begin.
 */
function loadsPostgres(node) {
  if (ts.isImportDeclaration(node)) {
    if (!isPostgresSpecifier(node.moduleSpecifier)) return false;
    const clause = node.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const named = clause.namedBindings;
    return !(named && ts.isNamedImports(named) && allTypeOnly(named.elements));
  }
  if (ts.isExportDeclaration(node)) {
    if (!isPostgresSpecifier(node.moduleSpecifier) || node.isTypeOnly) return false;
    const named = node.exportClause;
    return !(named && ts.isNamedExports(named) && allTypeOnly(named.elements));
  }
  if (ts.isImportEqualsDeclaration(node)) {
    return (
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isPostgresSpecifier(node.moduleReference.expression)
    );
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const loader =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require');
    return loader && isPostgresSpecifier(node.arguments[0]);
  }
  return false;
}

const allTypeOnly = (elements) => elements.length > 0 && elements.every((e) => e.isTypeOnly);

/**
 * The line of every place `file` loads postgres.js as a value.
 *
 * A file whose text never spells the package name cannot import it, so only
 * the handful that do are parsed. The script kind follows the extension, as it
 * does for tsc, so an .mjs file is read as JavaScript and a .tsx file with JSX.
 */
function postgresLoads(file) {
  const contents = read(file);
  if (!contents.includes('postgres')) return [];

  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    if (loadsPostgres(node)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

export function checkPoolConfinement() {
  const rule = 'pool-confinement';

  // Passing by finding nothing is this rule's normal state, so it first checks
  // the thing it confines is still there under the name it looks for.
  if (!scannableSource.includes(OWNER)) {
    fail(rule, OWNER, 'is missing — the pool has no owner to confine it to');
    return;
  }
  if (!/export function getSql\s*\(/.test(stripComments(read(OWNER)))) {
    fail(
      rule,
      OWNER,
      'no longer declares getSql() — name whatever opens the transaction-pooler pool now in scripts/ci/rules/pool-confinement.mjs, or the rule checks nothing',
    );
  }
  // The same for the import check: the owner opens its pool with postgres.js,
  // so a reading that cannot find that import cannot find anybody else's.
  if (postgresLoads(OWNER).length === 0) {
    fail(
      rule,
      OWNER,
      'does not load postgres.js as this rule reads it — either the pool moved (name its new owner as OWNER in scripts/ci/rules/pool-confinement.mjs) or the import check has stopped recognising an import, and passes by seeing none',
    );
  }

  const others = scannableSource.filter((f) => f !== OWNER && !isTest(f));

  scan(others, /\bgetSql\b/g, (file, line) => {
    fail(
      rule,
      `${file}:${line}`,
      'names getSql, the raw pool — a query on it skips the admission gate and can pipeline through the transaction pooler (§6.91); go through `db`, or add what you need to db/client.ts and gate it there as databaseProbe() is',
    );
  });

  scan(others, /\$client\b/g, (file, line) => {
    fail(
      rule,
      `${file}:${line}`,
      "uses drizzle's $client, which is the raw pool — a tagged template on it skips the admission gate and can pipeline through the transaction pooler (§6.91); go through `db`, whose queries the gate admits",
    );
  });

  scan(others, /\b__shipbluSql\b/g, (file, line) => {
    fail(
      rule,
      `${file}:${line}`,
      'reads the pool db/client.ts parks on globalThis — that is the raw pool, outside the admission gate (§6.91); go through `db`',
    );
  });

  for (const file of others.filter((f) => !POSTGRES_IMPORTERS.has(f))) {
    for (const line of postgresLoads(file)) {
      fail(
        rule,
        `${file}:${line}`,
        'imports postgres.js — a second pool on the transaction pooler has no admission gate and can pipeline (§6.91); use `db` from db/client.ts (sessionSql() for LISTEN), `import type` if only its types are needed, or name this module in POSTGRES_IMPORTERS with its reason',
      );
    }
  }

  for (const file of POSTGRES_IMPORTERS.keys()) {
    if (!scannableSource.includes(file)) {
      fail(
        rule,
        file,
        'may import postgres.js but no such file — remove it from POSTGRES_IMPORTERS',
      );
    } else if (postgresLoads(file).length === 0) {
      fail(
        rule,
        file,
        'may import postgres.js but no longer does — remove it from POSTGRES_IMPORTERS, so the exemption cannot outlive its reason',
      );
    }
  }
}
