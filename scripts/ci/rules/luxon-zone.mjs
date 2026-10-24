import ts from 'typescript';
import { fail, lineOfNode, parseSource, requireAtLeast, scannableSource } from '../lib.mjs';

// ---------------------------------------------------------------------------
// Every luxon DateTime names the zone it reads in
//
// A luxon constructor given no zone uses the host's: UTC in CI and on Render,
// Cairo on the team's machines. The two disagree about more than the hour.
// Cairo springs forward at midnight, so the last Friday of April has no 00:00
// there (PROJECT-STATE §6.101), and `DateTime.fromISO('2027-04-30')` on a Cairo
// machine is 01:00. The `rangeIn` test counted a week from two such reads: it
// measured 5.958 days on every Cairo laptop whose week opened on a changeover,
// and stayed green in CI, which never meets a date without its midnight.
// AGENTS.md said so in a sentence; this is that sentence, checked.
//
// So, in any module that imports from luxon:
//   - `fromISO`, `fromSQL`, `fromRFC2822`, `fromHTTP`, `fromJSDate`,
//     `fromMillis`, `fromSeconds` and `fromObject` take an options object
//     literal with a `zone`, as their second argument; `fromFormat`,
//     `fromFormatParser` and `fromFormat`'s old name `fromString`, as their
//     third; `local`, as its last. `utc` names its zone by being called.
//   - `DateTime.now()` is read through `.setZone(…)` or `.toUTC()`, and not
//     with `keepLocalTime` or `keepCalendarTime`, which carry the host's wall
//     clock into the zone named.
//   - The zone is not the host's by another spelling. luxon reads `'local'`,
//     `'system'` and `'default'`, in any case, as the host's zone, and a zone
//     that is `undefined` or `null` the same way; so those are refused as the
//     value of `zone`, in either arm of a conditional, and given to
//     `setZone`, as is a `setZone()` naming nothing and `.toLocal()`. A spread
//     after `zone` is refused too, since it can replace it.
// A value that carries its own offset is no exception: it is read the same
// with `{ zone: 'utc' }`, and then the call says so rather than leaving a
// reader to check the string. A calendar date takes 'utc', where every date has
// its midnight. A wall-clock time written without an offset is not read through
// `fromISO` with a zone at all, but through `wallClockInstant()` in
// `lib/hours/wall-clock.ts`, because luxon picks between the two instances of
// the hour the autumn change repeats by the offset in force on the day it runs
// (§6.102); this rule cannot tell that call from one reading an instant in
// Cairo, so it asks only that the zone be named.
//
// The options must be a literal, because a variable cannot be read here and
// nothing in the tree passes one today; a helper that forwards options names
// the zone where it builds them. `.toLocal()` and `setZone` are matched by
// name on any receiver in such a module, since a variable's type cannot be
// read either, and nothing else here has methods of those names. What it
// cannot see: `Settings.defaultZone` set elsewhere, which changes what "no
// zone" means for every call; luxon's other zone-reading entry points
// (`Interval.fromISO`, `Info`), which nothing imports; luxon reached through a
// barrel that re-exports it, `require` or `import()`; a method taken off
// `DateTime` into a variable; a zone held in a variable that is `undefined` at
// run time; and a native `Date` read in the host's zone (`new Date(y, m, d)`,
// `getDate()`), which needs its type to be told from anything else.
// ---------------------------------------------------------------------------

/** The constructors that take options, by the index the options sit at. */
const OPTIONS_AT = new Map([
  ['fromISO', 1],
  ['fromSQL', 1],
  ['fromRFC2822', 1],
  ['fromHTTP', 1],
  ['fromJSDate', 1],
  ['fromMillis', 1],
  ['fromSeconds', 1],
  ['fromObject', 1],
  ['fromFormat', 2],
  ['fromFormatParser', 2],
  ['fromString', 2],
]);

/** What `now()` may be read through: a call that names the zone. */
const NAMES_A_ZONE = new Set(['setZone', 'toUTC']);

/** The host's zone, by the names luxon reads it under once lowercased. */
const HOST = new Set(['local', 'system', 'default']);

/** The options that keep the host's wall clock while changing the zone. */
const KEEPS_WALL_CLOCK = new Set(['keepLocalTime', 'keepCalendarTime']);

const REMEDY =
  "name the zone: 'utc' for a calendar date or a value carrying its own offset, TEAM_TIME_ZONE (or 'Africa/Cairo' in a test) to read an instant on a Cairo clock. A wall-clock time written without an offset goes through wallClockInstant() in lib/hours/wall-clock.ts instead (§6.102)";

export function checkLuxonNamesItsZone() {
  const rule = 'luxon-zone';

  let modules = 0;
  for (const file of scannableSource) {
    const source = parseSource(file);
    const bindings = luxonBindings(source);
    if (!bindings) continue;
    modules++;

    const report = (node, message) => fail(rule, `${file}:${lineOfNode(source, node)}`, message);

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const method = dateTimeMethod(node.expression, bindings);
        if (method === 'now') {
          checkNow(node, report);
        } else if (method === 'local') {
          checkOptions(node, method, node.arguments.length - 1, report);
        } else if (method && OPTIONS_AT.has(method)) {
          checkOptions(node, method, OPTIONS_AT.get(method), report);
        } else if (ts.isPropertyAccessExpression(node.expression)) {
          const name = node.expression.name.text;
          if (name === 'toLocal') {
            report(node, `converts to the host's zone with .toLocal() (§6.101); ${REMEDY}`);
          } else if (
            name === 'setZone' &&
            (!node.arguments[0] || namesTheHost(node.arguments[0]))
          ) {
            report(node, `sets the host's zone, by name or by naming none (§6.101); ${REMEDY}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  // About thirty modules import luxon today. A rule that finds fewer than half
  // has stopped recognising the import, not seen a codebase that stopped using
  // it.
  requireAtLeast(rule, '(repository)', modules, 15, 'modules importing luxon');
}

/**
 * How `DateTime` is reachable in this module: every local name it is
 * imported under (`import { DateTime as D }`) and every namespace an
 * `import * as luxon` binds. Null when the module imports nothing from luxon;
 * empty sets when it imports something else, such as `Interval`, whose
 * DateTimes the method checks still hold.
 */
function luxonBindings(source) {
  let bindings = null;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'luxon') continue;
    bindings ??= { locals: new Set(), namespaces: new Set() };
    const named = statement.importClause?.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      bindings.namespaces.add(named.name.text);
      continue;
    }
    for (const element of named.elements) {
      if ((element.propertyName ?? element.name).text === 'DateTime') {
        bindings.locals.add(element.name.text);
      }
    }
  }
  return bindings;
}

/** The method a callee calls on luxon's `DateTime`, or null. */
function dateTimeMethod(callee, bindings) {
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const target = callee.expression;
  const isDateTime =
    (ts.isIdentifier(target) && bindings.locals.has(target.text)) ||
    (ts.isPropertyAccessExpression(target) &&
      target.name.text === 'DateTime' &&
      ts.isIdentifier(target.expression) &&
      bindings.namespaces.has(target.expression.text));
  return isDateTime ? callee.name.text : null;
}

/**
 * `DateTime.now()` read through a call that names its zone, without keeping
 * the host's wall clock. A `setZone` naming the host is reported by the
 * `setZone` check itself, which sees every call of that name.
 */
function checkNow(call, report) {
  const parent = call.parent;
  const reader =
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === call &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
      ? parent.parent
      : null;
  if (!reader || !NAMES_A_ZONE.has(parent.name.text)) {
    report(
      call,
      `reads DateTime.now() in the host's zone — UTC in CI and on Render, Cairo on a laptop (§6.101). Read it through .setZone(…) or .toUTC(); ${REMEDY}`,
    );
    return;
  }
  const options = unwrap(reader.arguments[1]);
  if (options && ts.isObjectLiteralExpression(options)) {
    const keep = options.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        KEEPS_WALL_CLOCK.has(propertyName(property.name)) &&
        unwrap(property.initializer).kind === ts.SyntaxKind.TrueKeyword,
    );
    if (keep) {
      report(
        call,
        `reads DateTime.now() through ${parent.name.text}(…) with ${propertyName(keep.name)}, which keeps the host's wall clock and so its zone (§6.101); ${REMEDY}`,
      );
    }
  }
}

function checkOptions(call, method, index, report) {
  const options = unwrap(index >= 0 ? call.arguments[index] : undefined);
  if (!options || !ts.isObjectLiteralExpression(options)) {
    report(
      call,
      `builds DateTime.${method}() with no zone, so it reads in the host's — UTC in CI and on Render, Cairo on a laptop, where the day the clocks spring forward has no midnight (§6.101). ` +
        `Pass the options as an object literal with a zone; ${REMEDY}`,
    );
    return;
  }
  const at = options.properties.findIndex(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property.name) === 'zone',
  );
  if (at < 0) {
    report(
      call,
      `builds DateTime.${method}() with options but no zone, so it reads in the host's (§6.101); ${REMEDY}`,
    );
    return;
  }
  const zone = options.properties[at];
  if (ts.isPropertyAssignment(zone) && namesTheHost(zone.initializer)) {
    report(
      call,
      `builds DateTime.${method}() in the host's zone, by name or as undefined (§6.101); ${REMEDY}`,
    );
  } else if (options.properties.slice(at + 1).some((p) => ts.isSpreadAssignment(p))) {
    report(
      call,
      `builds DateTime.${method}() with a spread after its zone, which can replace it (§6.101). Put the zone last; ${REMEDY}`,
    );
  }
}

/** A property's name, written plainly, quoted or as a computed string. */
function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrap(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  }
  return null;
}

/**
 * Whether a zone, as written, is the host's: one of its names in any case,
 * `undefined`, `null` or `void 0`, or either arm of a conditional or the
 * fallback of `??` / `||` being one. A variable or a call cannot be read here
 * and is taken as naming a zone.
 */
function namesTheHost(node) {
  const value = unwrap(node);
  if (!value) return false;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return HOST.has(value.text.toLowerCase());
  }
  if (ts.isIdentifier(value)) return value.text === 'undefined';
  if (value.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(value)) return true;
  if (ts.isConditionalExpression(value)) {
    return namesTheHost(value.whenTrue) || namesTheHost(value.whenFalse);
  }
  if (
    ts.isBinaryExpression(value) &&
    (value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return namesTheHost(value.right);
  }
  return false;
}

/** The expression inside parentheses, `as`, `satisfies`, `<T>` and `!`. */
function unwrap(node) {
  let inner = node;
  while (
    inner &&
    (ts.isParenthesizedExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isSatisfiesExpression(inner) ||
      ts.isTypeAssertionExpression(inner) ||
      ts.isNonNullExpression(inner))
  ) {
    inner = inner.expression;
  }
  return inner;
}
