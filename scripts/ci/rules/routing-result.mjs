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
// in the writer's answer and nowhere else: `setConversationCategory` — and
// `setConversationCategoryOn`, its body for a caller already holding the
// ticket's lock, as Jev's classifier does — writes nothing for a category the
// ticket already carries or one retired since,
// `moveToGroupIfElsewhere` nothing for the group the ticket is in, and
// `assignConversation` handed a `groupId` answers `movedGroup`, false when the
// ticket was already there or held by somebody it may not take from. A caller
// that throws the answer away therefore cannot owe the follow-up correctly —
// it either skips it, and a policy keyed on the category or group is never
// reached, or calls it on every write, and a rule naming the group a ticket is
// in re-selects on every pass. The router (Stage 5) moves the group through
// `moveToGroupIfElsewhere`, and Jev (4.1) writes through
// `setConversationCategoryOn` under its own row lock, so both are held here. A
// writer that updates the column itself adds itself to WRITERS in the PR that
// lands it.
//
// So, outside tests, two halves:
//
//   - A call to any of them is not a statement of its own — awaited or not,
//     parenthesised or cast — nor `void`ed. Kept in a variable, in a
//     condition, returned or passed on, it is somebody's answer to use.
//     `assignConversation` counts only when its options can name a group:
//     without one it never moves the ticket, so a caller assigning in the
//     group the ticket is in owes nothing for its answer, kept or dropped —
//     Hand to after its own move (`lib/routing/hand-to.ts`, which reads the
//     answer only for what it tells the agent), the lifecycle's `autoAssign`
//     and `afterHoldEnded`. Given a `routed` carrier it answers through that
//     instead, which is how the engine hears of a move the pick after it then
//     failed (`AssignOptions.routed`).
//   - A module that calls one also calls `afterRoutingChanged`, unless it
//     exports a writer of its own and so hands the answer on: `lib/assignment`
//     answers `movedGroup`, `lib/categories/write.ts` wraps its transaction's
//     writer. That is what catches a new caller — Jev, the router — that keeps
//     the answer and never owes anything for it.
//
// A write that by design owes nothing is a writer of its own, named in
// NO_FOLLOW_UP with the one module that may call it, so the exemption is a
// property of a function a reviewer can read rather than of a comment any call
// site could carry. `fileBacklogCategory` is the one so far:
// `backfill_category_ai`'s apply mode files a backlog and fires nothing (plan
// 4.1). Its answer is still kept, and a call from any other module fails.
//
// What it cannot see: an answer kept and then ignored in a module that does
// call `afterRoutingChanged` somewhere, which only reading the caller can judge
// — returned from a callback or put in an array (a `db.transaction`, a
// `Promise.all`) whose own result is then dropped is that case too; a writer
// reached under another name (an alias, a method taken into a variable);
// `.then()`, `.catch()` or `.finally()` on the call, which nothing here uses;
// and an update of `category_id` or `group_id` written out rather than made
// through a writer named here. A call dropped under `&&`, `?:` or a comma is
// not looked for: `npm run lint` refuses each of those statements first
// (`no-unused-expressions`). Tests are left out because a fixture sets a
// category it never asks about.
// ---------------------------------------------------------------------------

const WRITERS = new Set([
  'setConversationCategory',
  'setConversationCategoryOn',
  'moveToGroupIfElsewhere',
  'assignConversation',
]);

/** Writers that owe no follow-up by design, each with the one module that may call it. */
const NO_FOLLOW_UP = new Map([['fileBacklogCategory', 'lib/category-ai/backfill.ts']]);

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
 * The name a property is written under — `groupId`, `'groupId'` or
 * `['groupId']` — or undefined for a computed key that could be anything.
 */
function keyOf(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

/**
 * Whether an options object written out can carry `key`: a property of that
 * name, a spread or a computed key, which may hold one. Options built
 * elsewhere are judged by the caller.
 */
function mayCarry(options, key) {
  return options.properties.some(
    (property) =>
      ts.isSpreadAssignment(property) ||
      (property.name !== undefined && [key, undefined].includes(keyOf(property.name))),
  );
}

/**
 * Whether `assignConversation`'s options can name a group to move to: an object
 * that may carry a `groupId`, or options built elsewhere, which only reading
 * the caller could rule out.
 */
function canNameAGroup(options) {
  if (!options) return false;
  return !ts.isObjectLiteralExpression(options) || mayCarry(options, 'groupId');
}

/** An `assignConversation` handed a `routed` carrier, written out, answers through it. */
function answersThroughCarrier(name, call) {
  const options = call.arguments[1];
  return (
    name === 'assignConversation' &&
    options !== undefined &&
    ts.isObjectLiteralExpression(options) &&
    options.properties.some(
      (property) => property.name !== undefined && keyOf(property.name) === 'routed',
    )
  );
}

/** The name a call is made by: `f()`, `o.f()` or `o['f']()`. */
function calleeName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text;
  }
  return null;
}

function writerCalled(call) {
  const name = calleeName(call);
  if (!name || !(WRITERS.has(name) || NO_FOLLOW_UP.has(name))) return null;
  if (name === 'assignConversation' && !canNameAGroup(call.arguments[1])) return null;
  return name;
}

/** Whether the module exports a function named as a writer, handing its answer on. */
function exportsAWriter(source) {
  const exported = (node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  return source.statements.some(
    (statement) =>
      exported(statement) &&
      ((ts.isFunctionDeclaration(statement) && isWriter(statement.name?.text)) ||
        (ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) => ts.isIdentifier(declaration.name) && isWriter(declaration.name.text),
          ))),
  );
}

function isWriter(name) {
  return WRITERS.has(name) || NO_FOLLOW_UP.has(name);
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
    if (![...WRITERS, ...NO_FOLLOW_UP.keys()].some((name) => text.includes(name))) continue;

    const source = parseSource(file);
    let firstWriter = null;
    let followsUp = false;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        if (calleeName(node) === 'afterRoutingChanged') followsUp = true;
        const writer = writerCalled(node);
        if (writer) {
          calls++;
          const confinedTo = NO_FOLLOW_UP.get(writer);
          if (confinedTo === undefined) firstWriter ??= { writer, node };
          else if (file !== confinedTo) {
            fail(
              rule,
              `${file}:${lineOfNode(source, node)}`,
              `calls ${writer}(), which writes without the follow-up and is ${confinedTo}'s alone — write through a writer that owes afterRoutingChanged(), or argue for another no-follow-up writer in NO_FOLLOW_UP`,
            );
          }
          if (discarded(node) && !answersThroughCarrier(writer, node)) {
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

    if (firstWriter && !followsUp && !exportsAWriter(source)) {
      fail(
        rule,
        `${file}:${lineOfNode(source, firstWriter.node)}`,
        `calls ${firstWriter.writer}() and never afterRoutingChanged() — a module that changes a ticket's routing owes the follow-up once the whole change is over, or exports a writer of its own that hands the answer on`,
      );
    }
  }

  // Ten calls outside tests today: the console's group and category cases,
  // the engine's set_category, assign_group and auto_assign, assignment's own
  // move, the two wrappers in lib/categories/write.ts, Jev's classifier, and
  // the backfill's apply mode through `fileBacklogCategory`.
  requireAtLeast(rule, 'lib/ and app/', calls, 4, 'calls of a routing writer');
}
