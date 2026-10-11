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
//  - `postgres` imported at all: a second pool on DATABASE_URL is ungated from
//    the start, and its connections are not counted against the gate's.
//
// Tests are left alone: they exercise the gate and the driver directly, on
// pools they open and close themselves. db/migrate.ts may open a pool of its
// own, and is named below with the reason.
//
// What it cannot see: `db._.session.client`, which drizzle types as a generic
// session and so needs a cast to reach — a cast a reviewer can see.
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

  scan(
    others.filter((f) => !POSTGRES_IMPORTERS.has(f)),
    /from\s*'postgres'|import\(\s*'postgres'\s*\)|require\(\s*'postgres'\s*\)/g,
    (file, line) => {
      fail(
        rule,
        `${file}:${line}`,
        'imports postgres.js — a second pool on the transaction pooler has no admission gate and can pipeline (§6.91); use `db` from db/client.ts (sessionSql() for LISTEN), or name this module in POSTGRES_IMPORTERS with its reason',
      );
    },
  );

  for (const file of POSTGRES_IMPORTERS.keys()) {
    if (!scannableSource.includes(file)) {
      fail(
        rule,
        file,
        'may import postgres.js but no such file — remove it from POSTGRES_IMPORTERS',
      );
    }
  }
}
