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
// nothing for a category the ticket already carries or one retired since, and
// `moveToGroupIfElsewhere` nothing for the group the ticket is in. A caller
// that throws the answer away therefore cannot owe the follow-up correctly —
// it either skips it, and a policy keyed on the category or group is never
// reached, or calls it on every write, and a rule naming the group a ticket is
// in re-selects on every pass. Jev (4.1) and the router (Stage 5) are the
// writers still to come, so this is held now rather than remembered then.
//
// So, outside tests: a call to either writer is not a statement of its own —
// awaited or not, parenthesised or cast — nor `void`ed. Kept in a variable, in
// a condition, returned or passed on, it is somebody's answer to use.
//
// What it cannot see: an answer kept and then ignored, which only reading the
// caller can judge; a writer reached under another name (an alias, a method
// taken into a variable); and `.then()` on the call, which nothing here uses.
// Tests are left out because a fixture sets a category it never asks about.
// ---------------------------------------------------------------------------

const WRITERS = new Set(['setConversationCategory', 'moveToGroupIfElsewhere']);

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

function writerCalled(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return WRITERS.has(callee.text) ? callee.text : null;
  if (ts.isPropertyAccessExpression(callee) && WRITERS.has(callee.name.text)) {
    return callee.name.text;
  }
  return null;
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

  // Five calls outside tests today: the console's group and category cases,
  // the engine's set_category and assign_group, and assignment's own move.
  requireAtLeast(rule, 'lib/ and app/', calls, 4, 'calls of a routing writer');
}
