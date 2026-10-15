import ts from 'typescript';
import {
  bundledImports,
  directiveOf,
  fail,
  lineOfNode,
  parseSource,
  requireAtLeast,
  scannableSource,
} from '../lib.mjs';

// ---------------------------------------------------------------------------
// A date a client component draws is joined from its fields, in lib/format.ts
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
//   - `Intl.DateTimeFormat` appears only in `lib/format.ts`. A confinement
//     rather than a judgement of each use, because the judgement cannot be
//     made from syntax: `.formatToParts(at).map((p) => p.value).join('')`
//     rebuilds the engine's whole string, punctuation and all, and only
//     reading what the caller keeps of the parts tells it apart from a join.
//     The name is refused wherever it is a value — `Intl.DateTimeFormat`,
//     `globalThis.Intl.DateTimeFormat`, `Intl['DateTimeFormat']`,
//     `const { DateTimeFormat } = Intl`, a subclass — and not where it names a
//     type. `supportedLocalesOf` and `instanceof` are refused with the rest; a
//     client module that needs either asks `lib/format.ts`.
//   - `Intl.RelativeTimeFormat` is not used, `lib/format.ts` included: its
//     wording is locale data too.
//   - None of the engine's own date strings are called for, `lib/format.ts`
//     included: `toLocaleDateString`, `toLocaleTimeString`, `toLocaleString`,
//     and `toDateString` / `toTimeString`, which read the runtime's time zone —
//     UTC on Render, Cairo in the browser. `toLocaleString` is a number's method
//     as well, which this cannot tell from a date's; a number takes
//     `Intl.NumberFormat`, as `formatCount` does.
//   - luxon, which `lib/hours` brings into the bundle, is held to the same:
//     `toRelative` and `toRelativeCalendar` word a relative time from locale
//     data, and a `toFormat` pattern written as a literal may spell its fields
//     out (`cccc HH:mm`) but not use a localized macro (`D`, `t`, `f`, `F` and
//     their longer forms), which is the engine's whole string again.
//
// Module by module, not function by function: a whole-string formatter only a
// server page calls is still refused if the module it sits in is in the
// bundle for something else. That is the split `lib/kb/dates.ts` makes from
// `lib/kb/locale.ts`, and the one `lib/kb/floors.ts` makes from
// `lib/kb/internal.ts` for the schema. Nor can it tell a date formatted while
// rendering from one formatted in an effect or an event handler, where nothing
// hydrates, so it refuses both; the remedy is the same one line either way.
//
// What syntax cannot see: a `Date` turned into text by `String(at)`, a
// template literal or `.toString()` — the same time-zone difference, but
// telling a date from any other value there needs its type, which a rule that
// reads one file at a time does not have.
// ---------------------------------------------------------------------------

/** The one module allowed a formatter, because it joins every field it reads. */
const OWNER = 'lib/format.ts';

const CONFINED = 'DateTimeFormat';
const REFUSED = 'RelativeTimeFormat';

const ENGINE_STRINGS = new Set([
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleString',
  'toDateString',
  'toTimeString',
  'toRelative',
  'toRelativeCalendar',
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
    if (!/\.tsx?$/.test(file)) continue;
    const via = route.length > 1 ? ` (in the browser bundle through ${route.join(' → ')})` : '';
    const source = parseSource(file);
    const report = (node, message) => fail(rule, `${file}:${lineOfNode(source, node)}`, message);

    const visit = (node) => {
      if (namesAType(node)) return;

      const name = intlName(node);
      if (name === CONFINED && file !== OWNER) {
        report(
          node,
          `uses Intl.DateTimeFormat outside ${OWNER}${via}. Its whole string carries punctuation from locale data the server and the browser each ship their own copy of (§6.96), ` +
            `and a string rebuilt from its parts keeps that punctuation unless the literals are dropped — format the date in ${OWNER}, which joins the fields with separators of its own`,
        );
      } else if (name === REFUSED) {
        report(
          node,
          `uses Intl.RelativeTimeFormat${via}, whose wording is locale data the server and the browser can disagree about (§6.96) — use formatRelative in ${OWNER}`,
        );
      } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (ENGINE_STRINGS.has(method)) {
          report(
            node,
            `calls ${method}()${via}, a string the server and the browser write from their own locale data or time zone (§6.96) — ` +
              `a date goes through ${OWNER}, a number through Intl.NumberFormat`,
          );
        } else if (method === 'toFormat') {
          const macro = localizedMacro(node.arguments[0]);
          if (macro) {
            report(
              node,
              `formats with luxon's localized macro '${macro}'${via}, the engine's whole string by another name (§6.96) — spell the fields out in the pattern, or format the date in ${OWNER}`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

/**
 * A type annotation, which names `Intl.DateTimeFormat` without running it. The
 * one type-shaped node that does run is a class's `extends` clause, so a
 * subclass of the formatter is still read.
 */
function namesAType(node) {
  if (!ts.isTypeNode(node)) return false;
  return !(
    ts.isExpressionWithTypeArguments(node) &&
    ts.isHeritageClause(node.parent) &&
    node.parent.token === ts.SyntaxKind.ExtendsKeyword &&
    ts.isClassLike(node.parent.parent)
  );
}

/**
 * The formatter a value-position node names, however it is spelled: a
 * property access or a binding (`Intl.X`, `globalThis.Intl.X`,
 * `const { X } = Intl`) is an identifier `X`, and `Intl['X']` a string in an
 * element access.
 */
function intlName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    ts.isElementAccessExpression(node.parent) &&
    node.parent.argumentExpression === node
  ) {
    return node.text;
  }
  return null;
}

/**
 * The first localized macro in a luxon pattern written as a literal, or null.
 * Quoted text is literal in luxon and skipped; a pattern that is not a literal
 * cannot be read here and is let through.
 */
function localizedMacro(argument) {
  if (
    !argument ||
    !(ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
  ) {
    return null;
  }
  const tokens = argument.text.replace(/'[^']*'/g, '').match(/([A-Za-z])\1*/g) ?? [];
  return tokens.find((token) => 'DtTfF'.includes(token[0]) && token.length <= 4) ?? null;
}
