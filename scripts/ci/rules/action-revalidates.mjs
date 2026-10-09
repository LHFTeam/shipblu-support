import ts from 'typescript';
import { directiveOf, fail, read, requireAtLeast, resolveModule, scannable } from '../lib.mjs';

/**
 * A server action that answers success has revalidated first, on that path.
 *
 * Next renders the current page into an action's own response whenever the
 * action marked something revalidated (`pathWasRevalidated` in
 * next/dist/server/app-render/action-handler.js), and the client applies that
 * tree. So the console's forms no longer re-read the page after a success —
 * that was a second full server render, alongside LiveUpdates' own. The cost is
 * that a success which skipped `revalidatePath` now leaves the screen showing
 * what was there before it: the row the agent deleted is still in the list.
 *
 * What counts as success is what the form reads as one: `ok()`, an object
 * spreading it, or `ok: true`. A `{ error: null }` answer is left alone — the
 * help centre's registration answers it whether or not anything happened, on
 * purpose, and has nothing on the page to re-read.
 *
 * What counts as revalidating is what sets the flag: `revalidatePath`,
 * `updateTag` and `refresh` from next/cache, a `redirect`, or a function that
 * calls one of those as a statement of its own body — `refresh(number)` in
 * lib/tickets/console-guards.ts, `refresh(path)` in admin/settings-shared.ts.
 * `revalidateTag` is not on the list: with the profile it now requires it does
 * not mark the page (revalidate.js), so it would satisfy this check and still
 * leave the screen stale.
 *
 * "On that path" means a statement that runs before the return whatever
 * happened: an earlier statement in the block holding the return, or in any
 * block around it. A revalidation inside an `if` the return is not in does not
 * count, and neither does one after an early `return ok()` — which is the shape
 * this was written against.
 */
export function checkActionsRevalidate() {
  const rule = 'action-revalidates';

  let successes = 0;
  const files = scannable.filter(
    (f) =>
      /^(app|lib)\/.*\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && directiveOf(f) === 'server',
  );
  for (const file of files) {
    const source = parse(file);
    const revalidates = revalidatingNames(file, source);

    for (const statement of source.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.body || !isExported(statement))
        continue;
      for (const ret of ownReturns(statement)) {
        if (!isSuccess(ret.expression)) continue;
        successes++;
        if (dominated(ret, statement.body, revalidates)) continue;
        const { line } = source.getLineAndCharacterOfPosition(ret.getStart(source));
        fail(
          rule,
          `${file}:${line + 1}`,
          `${statement.name?.text ?? 'this action'} answers success here without revalidating first on this path — the form no longer re-reads the page, so call revalidatePath (or the shared refresh()) before this return`,
        );
      }
    }
  }

  // Today's actions answer success from about sixty-five places.
  requireAtLeast(rule, 'app/', successes, 30, "successful returns from 'use server' modules");
}

function parse(file) {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isExported(node) {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

const NEXT = {
  'next/cache': ['revalidatePath', 'updateTag', 'refresh'],
  'next/navigation': ['redirect', 'permanentRedirect'],
};

/**
 * The names that revalidate when called in `file`: Next's own, under whatever
 * local name they were imported as; then a function of this module or one it
 * imports whose body calls one of Next's as a statement. One level, read from
 * the module the import resolves to.
 */
function revalidatingNames(file, source) {
  const names = new Set(nextNames(source));
  const imports = namedImports(source);
  for (const [local, { spec, name }] of imports) {
    if (NEXT[spec]) continue;
    const target = resolveModule(spec, file);
    if (!target || !/\.tsx?$/.test(target)) continue;
    const helpers = parse(target);
    const fn = topFunction(helpers, name);
    if (fn && callsAsStatement(fn.body, new Set(nextNames(helpers)))) names.add(local);
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      if (callsAsStatement(statement.body, names)) names.add(statement.name.text);
    }
  }
  return names;
}

function nextNames(source) {
  const out = [];
  for (const [local, { spec, name }] of namedImports(source)) {
    if (NEXT[spec]?.includes(name)) out.push(local);
  }
  return out;
}

function namedImports(source) {
  const map = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      map.set(element.name.text, {
        spec: statement.moduleSpecifier.text,
        name: (element.propertyName ?? element.name).text,
      });
    }
  }
  return map;
}

function topFunction(source, name) {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
  }
  return null;
}

/** A top-level statement of `body` is a call to one of `names`. */
function callsAsStatement(body, names) {
  return Boolean(body && ts.isBlock(body) && body.statements.some((s) => isCallTo(s, names)));
}

function isCallTo(statement, names) {
  if (!ts.isExpressionStatement(statement)) return false;
  let expression = statement.expression;
  while (ts.isAwaitExpression(expression) || ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    names.has(expression.expression.text)
  );
}

/** The function's own returns, not those of a callback inside it. */
function ownReturns(fn) {
  const out = [];
  const visit = (node) => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return out;
}

function isSuccess(expression) {
  if (!expression) return false;
  while (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)) {
    expression = expression.expression;
  }
  if (ts.isConditionalExpression(expression)) {
    return isSuccess(expression.whenTrue) || isSuccess(expression.whenFalse);
  }
  if (isOkCall(expression)) return true;
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some(
    (p) =>
      (ts.isSpreadAssignment(p) && isOkCall(p.expression)) ||
      (ts.isPropertyAssignment(p) &&
        p.name.getText() === 'ok' &&
        p.initializer.kind === ts.SyntaxKind.TrueKeyword),
  );
}

function isOkCall(expression) {
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'ok'
  );
}

/** A call to one of `names` runs, as a statement, before `ret` on every path to it. */
function dominated(ret, body, names) {
  let node = ret;
  while (node !== body) {
    const parent = node.parent;
    const siblings =
      ts.isBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)
        ? parent.statements
        : [];
    for (const sibling of siblings) {
      if (sibling === node) break;
      if (isCallTo(sibling, names)) return true;
    }
    node = parent;
  }
  return false;
}
