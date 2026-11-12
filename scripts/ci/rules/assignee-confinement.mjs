import ts from 'typescript';
import {
  fail,
  lineOf,
  lineOfNode,
  parseSource,
  read,
  scannableSource,
  stripComments,
  tracked,
} from '../lib.mjs';

// ---------------------------------------------------------------------------
// The ticket's assignee
//
// A coexistence number's tickets are seen by the number's owner and by the
// agents who see every ticket, and by nobody else (lib/tickets/owner-only.ts).
// A rule about who may see a ticket is a rule about who may hold it: a ticket
// assigned to somebody it is hidden from is in nobody's list, counts against
// their capacity, and reads as taken to everybody who can see it.
//
// That was enforced writer by writer — the rota, the console, a rule, a
// handover, a reopen — which is enforced by whoever remembered. A ticket
// adopted onto a coexistence row while a colleague held it kept the colleague,
// because adoption wrote a channel and nobody thought of it as an assignment.
// So every write of `conversations.assignee_agent_id` is in one module,
// lib/tickets/assignee.ts, which asks the number under its lock before it
// writes, and this rule refuses the column written anywhere else:
//
//  - `assigneeAgentId` as a key of what a `.set(…)` or a `.values(…)` is
//    given: the object itself, an object spread into it (`...(cond ? {…} :
//    {})`), an element of the array `.values([…])` takes, and the `set` of an
//    `onConflictDoUpdate`. Read from the syntax tree, as pool-confinement
//    reads an import, because the same key is everywhere a ticket is *read* —
//    `.select({ assigneeAgentId: conversations.assigneeAgentId })`, a type, a
//    snapshot handed to a function — and a pattern over the text cannot tell
//    those from a write.
//  - `assignee_agent_id = …` in raw SQL, unqualified, in a source file or in
//    db/sql/ and db/runbooks/: the left side of a SET. A comparison in a WHERE
//    names its table (`c.assignee_agent_id = …`) or goes through the builder,
//    and passes.
//
// Tests are left alone: a fixture builds the ticket a test is about, held by
// whoever the case needs.
//
// What it cannot see: an object built elsewhere and spread in
// (`.values({ ...stamp })`). `ownerStamp`, the one there is, lives in the
// owner module for that reason. Nor a statement built from strings at run
// time, which no reading of the source can resolve.
// ---------------------------------------------------------------------------

const OWNER = 'lib/tickets/assignee.ts';

/** SQL files that may write the column, each with why TypeScript cannot. */
const SQL_WRITERS = new Map([
  [
    'db/sql/009_whatsapp_channel_backfill.sql',
    'files a ticket under its number at deploy, where no TypeScript runs, and only ever gives one to nobody — which every ticket allows — when the row is a coexistence number',
  ],
]);

const isTest = (file) => /\.test\.(ts|tsx|mts|mjs)$/.test(file);

const COLUMN = 'assigneeAgentId';
const SQL_COLUMN = 'assignee_agent_id';

/** The builder methods whose argument is the columns a statement writes. */
const WRITERS = new Set(['set', 'values', 'onConflictDoUpdate']);

const nameOf = (name) =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;

/**
 * Every place the object a writer is given names the column, as nodes.
 *
 * Followed through what still is that object: a spread, either arm of a
 * conditional or of `&&`, `||` and `??`, parentheses, a cast, the elements of
 * an array, and the `set` of an `onConflictDoUpdate`. Not into a call: what a
 * function is handed is its own argument (`routingWindowValues(plan, {
 * assigneeAgentId }, now)` reads the assignee to decide a window), and what it
 * returns is not in this file to read.
 */
function columnKeys(node, found = []) {
  if (!node) return found;
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        columnKeys(property.expression, found);
      } else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        const name = nameOf(property.name);
        if (name === COLUMN || name === SQL_COLUMN) found.push(property);
        else if (name === 'set' && ts.isPropertyAssignment(property)) {
          columnKeys(property.initializer, found);
        }
      }
    }
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) columnKeys(element, found);
  } else if (ts.isSpreadElement(node) || ts.isParenthesizedExpression(node)) {
    columnKeys(node.expression, found);
  } else if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    columnKeys(node.expression, found);
  } else if (ts.isConditionalExpression(node)) {
    columnKeys(node.whenTrue, found);
    columnKeys(node.whenFalse, found);
  } else if (ts.isBinaryExpression(node)) {
    columnKeys(node.left, found);
    columnKeys(node.right, found);
  }
  return found;
}

/** The line of every builder write of the column in `file`. */
function builderWrites(file) {
  if (!read(file).includes(COLUMN) && !read(file).includes(SQL_COLUMN)) return [];
  const source = parseSource(file);
  const lines = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITERS.has(node.expression.name.text)
    ) {
      for (const argument of node.arguments) {
        for (const key of columnKeys(argument)) lines.push(lineOfNode(source, key));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

/**
 * `assignee_agent_id = …` or `:= …`, unqualified or on a trigger's NEW row:
 * the column being given a value. `==` is a comparison in JavaScript and
 * `c.assignee_agent_id =` one in SQL, and neither matches.
 */
const SQL_WRITE = /(?<![.\w])(?:new\.)?assignee_agent_id\s*:?=(?!=)/gi;

const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));

function sqlWrites(file) {
  const raw = read(file);
  if (!raw.includes(SQL_COLUMN)) return [];
  const contents = file.endsWith('.sql') ? stripSqlComments(raw) : stripComments(raw);
  return [...contents.matchAll(SQL_WRITE)].map((match) => lineOf(contents, match.index));
}

export function checkAssigneeConfinement() {
  const rule = 'assignee-confinement';

  // Passing by finding nothing is this rule's normal state, so it first checks
  // the thing it confines is still there, and that it reads its writes as
  // writes: a reading that cannot find the owner's cannot find anybody else's.
  if (!scannableSource.includes(OWNER)) {
    fail(rule, OWNER, 'is missing — the assignee has no one writer to confine it to');
    return;
  }
  if (builderWrites(OWNER).length === 0) {
    fail(
      rule,
      OWNER,
      'does not write conversations.assignee_agent_id as this rule reads a write — either the writer moved (name it as OWNER in scripts/ci/rules/assignee-confinement.mjs) or the rule has stopped recognising a write, and passes by seeing none',
    );
  }

  for (const file of scannableSource.filter((f) => f !== OWNER && !isTest(f))) {
    for (const line of builderWrites(file)) {
      fail(
        rule,
        `${file}:${line}`,
        'writes conversations.assignee_agent_id itself — on a coexistence number that can leave a ticket with somebody it is hidden from (lib/tickets/owner-only.ts); go through lib/tickets/assignee.ts: lockHolders() before the ticket is locked or written, then assignTicket(), or unassignTicket() to give it to nobody',
      );
    }
    for (const line of sqlWrites(file)) {
      fail(
        rule,
        `${file}:${line}`,
        'writes assignee_agent_id in raw SQL — nothing there asks who may hold the ticket; go through lib/tickets/assignee.ts, or, if this is a comparison, name the table it reads (`c.assignee_agent_id = …`)',
      );
    }
  }

  const sqlFiles = tracked.filter((f) => /^db\/(sql|runbooks)\/.*\.sql$/.test(f));
  for (const file of sqlFiles.filter((f) => !SQL_WRITERS.has(f))) {
    for (const line of sqlWrites(file)) {
      fail(
        rule,
        `${file}:${line}`,
        'writes assignee_agent_id — SQL cannot ask who sees every ticket, which is can() over a role and an agent’s own overrides; assign in TypeScript through lib/tickets/assignee.ts, or name this file in SQL_WRITERS with what makes its write safe',
      );
    }
  }

  for (const file of SQL_WRITERS.keys()) {
    if (!tracked.includes(file)) {
      fail(rule, file, 'may write assignee_agent_id but no such file — remove it from SQL_WRITERS');
    } else if (sqlWrites(file).length === 0) {
      fail(
        rule,
        file,
        'may write assignee_agent_id but no longer does — remove it from SQL_WRITERS, so the exemption cannot outlive its reason',
      );
    }
  }
}
