import ts from 'typescript';
import { directiveOf, fail, read, requireAtLeast, resolveModule, scannable } from '../lib.mjs';

/**
 * A server action that answers success has revalidated first, on every branch
 * that reaches the answer.
 *
 * Next renders the current page into an action's own response whenever the
 * action marked something revalidated (`pathWasRevalidated` in
 * next/dist/server/app-render/action-handler.js), and the client applies that
 * tree. So the console's forms no longer re-read the page after a success —
 * that was a second full server render, alongside LiveUpdates' own (§6.87). The
 * cost is that a success which skipped `revalidatePath` now leaves the screen
 * showing what was there before it: the row the agent deleted is still in the
 * list.
 *
 * What counts as success is what a caller reads as one: `ok()`, an object
 * spreading it, `ok: true`, and — because the console's direct-call controls
 * test `!result.error` — an object with `error: null`. Type-only wrappers
 * (`as`, `satisfies`, `!`) are seen through. The help centre is left out of the
 * last shape: its errors are keys the page translates, and registration and
 * forgot-password answer `{ error: null }` whether or not anything happened, on
 * purpose, with nothing on the page to re-read.
 *
 * What counts as revalidating, called in the action: `revalidatePath`,
 * `updateTag` and `refresh` from next/cache, which mark the page; and
 * `redirect`, which renders its target instead, and after which nothing runs.
 * Or a function that calls one of the first three as a statement before any
 * return of its own — `refresh(number)` in lib/tickets/console-guards.ts,
 * `refresh(path)` in admin/settings-shared.ts. A helper's `redirect` does not
 * count: a guard like `requireAgent()` redirects only on the branch where the
 * caller never gets control back, and returns before it on every other.
 * `revalidateTag` is not on the list: whether it marks the page depends on the
 * profile it is given (revalidate.js), so it cannot stand in for the rest.
 *
 * "Before" means a statement that runs ahead of the return whatever happened:
 * an earlier statement in the block holding the return, or in any block around
 * it. A revalidation inside an `if` the return is not in does not count, and
 * neither does one after an early `return ok()` — which is the shape this was
 * written against. A revalidation in a `finally` is refused too, although it
 * would run in time; write it before the return.
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
    const errorNullIsSuccess = !file.startsWith('app/help/');

    const report = (node, name) => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      fail(
        rule,
        `${file}:${line + 1}`,
        `${name} answers success here without revalidating first — the form does not re-read the page, so call revalidatePath (or the shared refresh()) before this return`,
      );
    };

    for (const { name, fn } of exportedActions(source)) {
      // An arrow answering with an expression has no statement before it.
      if (!ts.isBlock(fn.body)) {
        if (isSuccess(fn.body, errorNullIsSuccess)) {
          successes++;
          report(fn.body, name);
        }
        continue;
      }
      for (const ret of ownReturns(fn)) {
        if (!isSuccess(ret.expression, errorNullIsSuccess)) continue;
        successes++;
        if (!dominated(ret, fn.body, revalidates)) report(ret, name);
      }
    }
  }

  // Today's actions answer success from about eighty places.
  requireAtLeast(rule, 'app/', successes, 30, "successful returns from 'use server' modules");
}

function parse(file) {
  return ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isExported(node) {
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Strips what changes a value's type and leaves the value alone. */
function unwrap(expression) {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAwaitExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

/**
 * Every export of the module that is a function, as Next publishes it: a
 * declaration, a `const` holding an arrow or a function expression, a local
 * name listed in `export { … }`, and the default.
 */
function exportedActions(source) {
  const locals = new Map();
  const isFn = (node) => node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      locals.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer && unwrap(declaration.initializer);
        if (ts.isIdentifier(declaration.name) && isFn(init)) {
          locals.set(declaration.name.text, init);
        }
      }
    }
  }

  const out = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && isExported(statement)) {
      out.push({ name: statement.name?.text ?? 'the default action', fn: statement });
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const fn = ts.isIdentifier(declaration.name) && locals.get(declaration.name.text);
        if (fn) out.push({ name: declaration.name.text, fn });
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const fn = locals.get((element.propertyName ?? element.name).text);
        if (fn) out.push({ name: element.name.text, fn });
      }
    } else if (ts.isExportAssignment(statement)) {
      const value = unwrap(statement.expression);
      const fn = isFn(value) ? value : ts.isIdentifier(value) && locals.get(value.text);
      if (fn) out.push({ name: 'the default action', fn });
    }
  }
  return out;
}

const NEXT = {
  'next/cache': ['revalidatePath', 'updateTag', 'refresh'],
  'next/navigation': ['redirect', 'permanentRedirect'],
};

/** The Next calls after which control comes back to the caller. */
const RETURNING = new Set(['revalidatePath', 'updateTag', 'refresh']);

/**
 * The names that revalidate when called in `file`: Next's own, under whatever
 * local name they were imported as; then a function of this module or one it
 * imports that calls one of the returning ones before it can return. One level,
 * read from the module the import resolves to.
 */
function revalidatingNames(file, source) {
  const names = new Set(nextNames(source));
  const seeds = new Set(nextNames(source, RETURNING));
  for (const [local, { spec, name }] of namedImports(source)) {
    if (NEXT[spec]) continue;
    const target = resolveModule(spec, file);
    if (!target || !/\.tsx?$/.test(target)) continue;
    const helpers = parse(target);
    const fn = topFunction(helpers, name);
    if (fn && revalidatesBeforeReturning(fn.body, new Set(nextNames(helpers, RETURNING)))) {
      names.add(local);
      seeds.add(local);
    }
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      if (revalidatesBeforeReturning(statement.body, seeds)) names.add(statement.name.text);
    }
  }
  return names;
}

function nextNames(source, only) {
  const out = [];
  for (const [local, { spec, name }] of namedImports(source)) {
    if (NEXT[spec]?.includes(name) && (!only || only.has(name))) out.push(local);
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

/**
 * A top-level statement of `body` calls one of `names` before any statement
 * that can return. `if (agent) return agent; redirect('/login')` does not
 * qualify, whatever the redirect is: the caller gets control back only through
 * the return.
 */
function revalidatesBeforeReturning(body, names) {
  if (!body || !ts.isBlock(body)) return false;
  for (const statement of body.statements) {
    if (isCallTo(statement, names)) return true;
    if (containsOwnReturn(statement)) return false;
  }
  return false;
}

function containsOwnReturn(node) {
  let found = false;
  const visit = (child) => {
    if (found || ts.isFunctionLike(child)) return;
    if (ts.isReturnStatement(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isCallTo(statement, names) {
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = unwrap(statement.expression);
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

function isSuccess(expression, errorNullIsSuccess) {
  if (!expression) return false;
  expression = unwrap(expression);
  if (ts.isConditionalExpression(expression)) {
    return (
      isSuccess(expression.whenTrue, errorNullIsSuccess) ||
      isSuccess(expression.whenFalse, errorNullIsSuccess)
    );
  }
  if (isOkCall(expression)) return true;
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some(
    (p) =>
      (ts.isSpreadAssignment(p) && isOkCall(p.expression)) ||
      (ts.isPropertyAssignment(p) &&
        p.name.getText() === 'ok' &&
        unwrap(p.initializer).kind === ts.SyntaxKind.TrueKeyword) ||
      (errorNullIsSuccess &&
        ts.isPropertyAssignment(p) &&
        p.name.getText() === 'error' &&
        unwrap(p.initializer).kind === ts.SyntaxKind.NullKeyword),
  );
}

function isOkCall(expression) {
  expression = unwrap(expression);
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
