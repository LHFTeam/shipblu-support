import ts from 'typescript';
import { fail, lineOfNode, parseSource, requireAtLeast, scannableSource } from '../lib.mjs';

// ---------------------------------------------------------------------------
// A lock on a ticket's row is FOR NO KEY UPDATE
//
// Every inbound path stores a message, and most writers an event, against a
// ticket, and each such insert holds KEY SHARE on the ticket's row, through
// its foreign key, until its transaction commits. FOR UPDATE is the one row
// lock KEY SHARE refuses. So a transaction that has written a ticket and then
// locks it again FOR UPDATE asks for an upgrade that waits on any such insert,
// while the inserting transaction's own update of the ticket waits on the
// first write, and Postgres aborts one of them: an agent's reply stored and
// never sent, a customer's message lost, a reopen that failed. `endHold` was
// the first (`docs/PROJECT-STATE.md` §6.106) and `alignAccountable` the
// second (§6.116), each after AGENTS.md had said so in prose. Taken before any
// write, FOR UPDATE closes no cycle, but holds every message arriving on the
// ticket until the lock's transaction commits, for nothing: NO KEY UPDATE
// serialises against every other writer of the row the same way, since no
// writer here changes the ticket's key.
//
// The one transaction that needs FOR UPDATE is one that deletes the ticket
// (`purgeConversation`). Its lock keeps a message from being stored between
// what the purge counts and records and the delete itself. That is told from
// the code rather than from a list: the function taking the lock deletes from
// `conversations` itself, through Drizzle or in SQL.
//
// So, outside tests, refused: a FOR UPDATE on a read that reaches
// `conversations` — a Drizzle `.for('update')` on a builder whose `.from` or
// any join names the table, unless its `of` names only other tables, or a SQL
// template saying `for update` and naming the table — in a function that does
// not delete from it. A builder held in a variable is followed to its
// declaration in the same module. What it cannot see: a builder handed in as
// an argument, the table reached through another name, a lock in a view or a
// function in the database, and a lock taken before the write in a function
// that deletes some other ticket.
// ---------------------------------------------------------------------------

const TABLE = 'conversations';

/** The builder calls that name a table the locked read reads. */
const SOURCES = new Set(['from', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin', 'crossJoin']);

const FUNCTIONS = new Set([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
]);

const isTest = (file) => /\.test\.(ts|tsx|mts|mjs)$/.test(file) || file.startsWith('lib/testing/');

const MESSAGE =
  "locks a ticket's row FOR UPDATE; take FOR NO KEY UPDATE. FOR UPDATE is the one lock the KEY SHARE of a message or event inserted for the ticket refuses: after a write in the same transaction it deadlocks with an ingest storing a message on the ticket, and before one it holds every arriving message until it commits (§6.106, §6.116). Only a function that deletes the ticket needs it";

export function checkTicketLocksAreNoKeyUpdate() {
  const rule = 'ticket-lock';

  let locks = 0;
  for (const file of scannableSource) {
    if (isTest(file)) continue;
    const source = parseSource(file);
    if (!source.text.includes(TABLE)) continue;

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const strength = drizzleLock(node, source);
        if (strength !== null) {
          locks++;
          if (strength === 'update' && !deletesTheTicket(node)) {
            fail(rule, `${file}:${lineOfNode(source, node)}`, MESSAGE);
          }
        }
      } else if (ts.isTaggedTemplateExpression(node) && sqlLocksForUpdate(node.template)) {
        locks++;
        if (!deletesTheTicket(node)) fail(rule, `${file}:${lineOfNode(source, node)}`, MESSAGE);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // Twenty-one reads lock a ticket's row today. A rule finding fewer than half
  // has stopped recognising the builder, not seen a codebase that stopped
  // locking tickets.
  requireAtLeast(rule, '(repository)', locks, 10, "locks on a ticket's row");
}

/**
 * The strength a Drizzle `.for(…)` call takes on a ticket's row — `'update'`,
 * `'no key update'` or another — or null when the call is not one or locks no
 * ticket.
 */
function drizzleLock(call, source) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'for') return null;
  const [strength, options] = call.arguments;
  if (!strength || !ts.isStringLiteralLike(strength)) return null;
  if (!readsTheTable(callee.expression, source, new Set())) return null;
  if (options && !lockOfNamesTheTable(options)) return null;
  return strength.text;
}

/** Whether the builder chain below `.for` reads the table, through any variable it was kept in. */
function readsTheTable(node, source, seen) {
  let current = node;
  while (current) {
    if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
    } else if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        SOURCES.has(callee.name.text) &&
        current.arguments[0] &&
        namesTheTable(current.arguments[0])
      ) {
        return true;
      }
      current = callee;
    } else if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    } else if (ts.isIdentifier(current)) {
      if (seen.has(current.text)) return false;
      seen.add(current.text);
      const initializer = declaredAs(current.text, source);
      return initializer ? readsTheTable(initializer, source, seen) : false;
    } else {
      return false;
    }
  }
  return false;
}

/** The initializer of a variable declared under `name` in the module, if one is. */
function declaredAs(name, source) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** `conversations`, or `schema.conversations`. */
function namesTheTable(node) {
  if (ts.isIdentifier(node)) return node.text === TABLE;
  if (ts.isPropertyAccessExpression(node)) return node.name.text === TABLE;
  return false;
}

/**
 * Whether `.for`'s options leave the ticket's row among those it locks: no
 * `of`, or an `of` naming the table. Anything it cannot read counts as naming
 * it, so a lock is refused rather than waved through.
 */
function lockOfNamesTheTable(options) {
  if (!ts.isObjectLiteralExpression(options)) return true;
  const of = options.properties.find(
    (p) => ts.isPropertyAssignment(p) && p.name && ts.isIdentifier(p.name) && p.name.text === 'of',
  );
  if (!of) return true;
  const value = of.initializer;
  if (ts.isArrayLiteralExpression(value)) return value.elements.some(namesTheTable);
  return ts.isIdentifier(value) || ts.isPropertyAccessExpression(value)
    ? namesTheTable(value)
    : true;
}

/** A SQL template that takes FOR UPDATE and names the table. */
function sqlLocksForUpdate(template) {
  const text = rendered(template);
  return /\bfor\s+update\b/i.test(text) && new RegExp(`\\b${TABLE}\\b`, 'i').test(text);
}

/**
 * A template's text with each interpolation written out: the table where it
 * names the table, so `from ${conversations}` reads as it runs, and a
 * placeholder anywhere else.
 */
function rendered(template) {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  return template.templateSpans.reduce(
    (text, span) => `${text}${namesTheTable(span.expression) ? TABLE : '$'}${span.literal.text}`,
    template.head.text,
  );
}

/** Whether the function taking the lock deletes from the table: the one place FOR UPDATE is owed. */
function deletesTheTicket(node) {
  let scope = node.parent;
  while (scope && !FUNCTIONS.has(scope.kind)) scope = scope.parent;
  if (!scope) return false;

  let deletes = false;
  const visit = (child) => {
    if (deletes) return;
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.name.text === 'delete' &&
      child.arguments[0] &&
      namesTheTable(child.arguments[0])
    ) {
      deletes = true;
      return;
    }
    if (
      ts.isTaggedTemplateExpression(child) &&
      new RegExp(`\\bdelete\\s+from\\s+${TABLE}\\b`, 'i').test(rendered(child.template))
    ) {
      deletes = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(scope);
  return deletes;
}
