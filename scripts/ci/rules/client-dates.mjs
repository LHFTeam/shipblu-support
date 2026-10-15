import ts from 'typescript';
import {
  bundledImports,
  directiveOf,
  fail,
  read,
  requireAtLeast,
  scannableSource,
} from '../lib.mjs';

// ---------------------------------------------------------------------------
// A date a client component draws is joined from its fields, not taken whole
//
// `Intl.DateTimeFormat` takes its patterns, punctuation included, from the
// locale data its runtime ships, and a client component is rendered twice, by
// two runtimes: on the server by Node, and again in the browser to hydrate.
// Node 22 writes `en-GB`'s long day "Wednesday, 14 October 2026" and Chromium
// 141 "Wednesday 14 October 2026", so the ticket thread's day break was a
// hydration error on every full load of every ticket, and React rebuilt the
// whole page each time with nothing on screen to say so (PROJECT-STATE §6.96).
// The fix was to join the fields with our own separators (`joined()` in
// `lib/format.ts`). This holds every other date in the browser bundle to it.
//
// So, in any module a `'use client'` file can reach:
//   - `Intl.DateTimeFormat` is built in `lib/format.ts`, or chained straight
//     into `.formatToParts(…)` so the caller joins the fields itself, as
//     `lib/tickets/custom-fields.ts` does. A formatter kept in a variable is
//     refused even when only its parts are read, because telling which method
//     a variable is later asked for is a type question, not a syntax one;
//     `lib/format.ts` is the module that keeps them.
//   - `Intl.RelativeTimeFormat` is not used: its words are locale data too.
//   - `toLocaleDateString`, `toLocaleTimeString` and `toLocaleString` are not
//     called. The last is a number's method as well, which this cannot tell
//     from a date's; a number takes `Intl.NumberFormat`, as `formatCount` does.
//
// Module by module, not function by function: a whole-string formatter only a
// server page calls is still refused if the module it sits in is in the
// bundle for something else. That is the split `lib/kb/dates.ts` makes from
// `lib/kb/locale.ts`, and the one `lib/kb/floors.ts` makes from
// `lib/kb/internal.ts` for the schema. Nor can it tell a date formatted while
// rendering from one formatted in an event handler, where nothing hydrates, so
// it refuses both; the remedy is the same one line either way.
//
// Read from the syntax tree, as `dom-title` explains, so a type annotation
// (`let f: Intl.DateTimeFormat`) and a comment are not mistaken for a call.
// ---------------------------------------------------------------------------

/** The one module allowed to keep a formatter, because it joins every field it reads. */
const OWNER = 'lib/format.ts';

const WHOLE_STRING_METHODS = new Set([
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleString',
]);

export function checkClientDatesJoinTheirFields() {
  const rule = 'client-dates';

  const entries = scannableSource.filter(
    (file) => /\.tsx?$/.test(file) && directiveOf(file) === 'client',
  );
  if (!requireAtLeast(rule, '(repository)', entries.length, 20, "'use client' entry points")) {
    return;
  }

  // Every module in the bundle, with one route to it: "chat.tsx → lib/x.ts"
  // says which import to move, where "lib/x.ts is in the bundle" does not.
  const routes = new Map(entries.map((entry) => [entry, [entry]]));
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const target of bundledImports(file)) {
      if (routes.has(target)) continue;
      routes.set(target, [...routes.get(file), target]);
      queue.push(target);
    }
  }

  for (const [file, route] of routes) {
    if (file === OWNER || !/\.tsx?$/.test(file)) continue;
    const via = route.length > 1 ? ` (in the browser bundle through ${route.join(' → ')})` : '';
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const at = (node) =>
      `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

    const visit = (node) => {
      if (isIntl(node, 'DateTimeFormat') && !chainedIntoParts(node)) {
        fail(
          rule,
          at(node),
          `formats a date as the engine's whole string${via}, and its punctuation is locale data the server and the browser each ship their own copy of (§6.96) — ` +
            `format it in ${OWNER}, which joins the fields with separators of its own, or chain .formatToParts() onto the formatter and join them here`,
        );
      } else if (isIntl(node, 'RelativeTimeFormat')) {
        fail(
          rule,
          at(node),
          `words a relative time from locale data${via}, which the server and the browser can disagree about (§6.96) — format it in ${OWNER}`,
        );
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        WHOLE_STRING_METHODS.has(node.expression.name.text)
      ) {
        fail(
          rule,
          at(node),
          `calls ${node.expression.name.text}()${via}, the engine's whole string, whose punctuation the server and the browser can disagree about (§6.96) — ` +
            `a date goes through ${OWNER}, a number through Intl.NumberFormat`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

/** `Intl.<name>` in a value position; a type annotation is a qualified name, not this. */
function isIntl(node, name) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Intl' &&
    node.name.text === name
  );
}

/** `new Intl.DateTimeFormat(…).formatToParts(…)`, or the same without `new`. */
function chainedIntoParts(reference) {
  const construct = reference.parent;
  if (!(ts.isNewExpression(construct) || ts.isCallExpression(construct))) return false;
  if (construct.expression !== reference) return false;
  const method = construct.parent;
  return (
    ts.isPropertyAccessExpression(method) &&
    method.expression === construct &&
    method.name.text === 'formatToParts' &&
    ts.isCallExpression(method.parent) &&
    method.parent.expression === method
  );
}
