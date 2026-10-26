import ts from 'typescript';
import { fail, lineOfNode, parseSource, read, requireAtLeast, scannableSource } from '../lib.mjs';

// ---------------------------------------------------------------------------
// A routing writer's answer is kept
//
// A ticket's category or group changed before anybody answered it owes a
// follow-up once the write commits: the SLA policy chosen again, then the
// clocks re-timed on the new group's hours — `afterRoutingChanged` in
// `lib/sla`, called once by whoever made the change
// (`plans/ticket-category-routing.md`, Stage 4.0). Whether anything changed is
// in the writer's answer and nowhere else: `setConversationCategory` writes
// nothing for a category the ticket already carries or one retired since,
// `moveToGroupIfElsewhere` nothing for the group the ticket is in, and
// `assignConversation` handed a `groupId` answers `movedGroup`, false when the
// ticket was already there or held by somebody it may not take from. A caller
// that throws the answer away therefore cannot owe the follow-up correctly —
// it either skips it, and a policy keyed on the category or group is never
// reached, or calls it on every write, and a rule naming the group a ticket is
// in re-selects on every pass. The router (Stage 5) moves the group through
// `moveToGroupIfElsewhere`, so it is held now rather than remembered then. Jev
// (4.1) decides under its own row lock; a writer of its own that updates the
// column itself adds itself to WRITERS in the PR that lands it.
//
// So, outside tests: a call to any of them is not a statement of its own —
// awaited or not, parenthesised or cast — nor `void`ed. Kept in a variable, in
// a condition, returned or passed on, it is somebody's answer to use.
// `assignConversation` counts only when its options can name a group: without
// one it never moves the ticket, and the console's group case (assigning in the
// group it has just moved to) and the lifecycle drop its answer owing nothing.
//
// What it cannot see: an answer kept and then ignored, which only reading the
// caller can judge — returned from a callback or put in an array (a
// `db.transaction`, a `Promise.all`) whose own result is then dropped is that
// case too; a writer reached under another name (an alias, a method taken into
// a variable); `.then()`, `.catch()` or `.finally()` on the call, which nothing
// here uses; and an update of `category_id` or `group_id` written out rather
// than made through a writer named here. Tests are left out because a fixture
// sets a category it never asks about.
// ---------------------------------------------------------------------------

const WRITERS = new Set([
  'setConversationCategory',
  'moveToGroupIfElsewhere',
  'assignConversation',
]);

/** Wrappers that change nothing about whether a value is used. */
function passesThrough(node) {
  return (
    ts.isAwaitExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  );
}

/**
 * Whether `assignConversation`'s options can name a group to move to: an object
 * written out with a `groupId`, or a spread that may carry one, or options
 * built elsewhere, which only reading the caller could rule out.
 */
function canNameAGroup(options) {
  if (!options) return false;
  if (!ts.isObjectLiteralExpression(options)) return true;
  return options.properties.some(
    (property) =>
      ts.isSpreadAssignment(property) ||
      (property.name !== undefined &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === 'groupId'),
  );
}

function writerCalled(call) {
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null;
  if (!name || !WRITERS.has(name)) return null;
  if (name === 'assignConversation' && !canNameAGroup(call.arguments[1])) return null;
  return name;
}

/** Whether the call's value, through any wrapper, is thrown away. */
function discarded(call) {
  let node = call;
  while (node.parent && passesThrough(node.parent)) node = node.parent;
  const parent = node.parent;
  return !parent || ts.isExpressionStatement(parent) || ts.isVoidExpression(parent);
}

export function checkRoutingResultKept() {
  const rule = 'routing-result';

  let calls = 0;
  for (const file of scannableSource) {
    if (/\.test\.[mc]?[jt]sx?$/.test(file)) continue;
    // Only a module that names a writer is parsed.
    const text = read(file);
    if (![...WRITERS].some((name) => text.includes(name))) continue;

    const source = parseSource(file);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const writer = writerCalled(node);
        if (writer) {
          calls++;
          if (discarded(node)) {
            fail(
              rule,
              `${file}:${lineOfNode(source, node)}`,
              `drops ${writer}()'s answer, which is the only thing saying whether the ticket's routing changed — keep it and pass it to afterRoutingChanged() in lib/sla once the whole change is over`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // Six calls outside tests today: the console's group and category cases,
  // the engine's set_category, assign_group and auto_assign, and assignment's
  // own move.
  requireAtLeast(rule, 'lib/ and app/', calls, 4, 'calls of a routing writer');
}
