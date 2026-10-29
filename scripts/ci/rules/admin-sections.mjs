import ts from 'typescript';
import { fail, lineOfNode, parseSource, requireAtLeast, scannable } from '../lib.mjs';

/**
 * The settings map agrees with the settings pages.
 *
 * `app/(console)/admin/sections.ts` is the one list the sidebar, the phone
 * strip, the settings home and its search are drawn from, and each entry names
 * the key that opens its page. The sidebar shows a link only to whoever the map
 * says may open it, so a key that disagrees with the page's own
 * `requirePermission` is one of two faults nobody reports: a link that answers
 * "forbidden" to everybody who holds the map's key and not the page's, or a page
 * its key-holders are never shown. And a page missing from the map is a page
 * nobody can find. The subcategory review queue and shadow runs were in no
 * sidebar before the map existed: each was a button in the Subcategories page's
 * header, and the review queue besides a link in one sentence of the
 * subcategory report that appears only while something is unclassified.
 *
 * So it fails on:
 *
 *  - a `page.tsx` under `app/(console)/admin/` that no entry names, page or
 *    child. The settings home (`/admin`) is the exception: it is the map's own
 *    page, and it opens on any key the map names (`SETTINGS_PERMISSIONS`);
 *  - an entry whose href no page serves — a link to a 404;
 *  - an entry whose key is not the page's: a string key must be the page's
 *    `requirePermission('k')`, an array the page's `requireAnyPermission([...])`
 *    with the same keys in any order. Only those calls count. A page asks
 *    `can()` for its controls as well, and a control's key says nothing about
 *    who may open the page;
 *  - an href named twice, which draws the link twice, lights both, and lets the
 *    two entries disagree about the key;
 *  - a child opened by a key its parent is not. The sidebar draws a child only
 *    under a parent its reader may open (`sectionsFor`), so whoever holds that
 *    key alone is let into the child page and never shown the way to it.
 *
 * A page's route is read off its path: `app/` and `page.tsx` dropped, and every
 * route group — `(console)`, or an `(x)` a later change uses to sort files —
 * since a group in parentheses is not in the URL. The route is then held to an
 * href exactly. That works only because URLs stay flat (see `sections.ts`): a
 * settings group is a heading, not a path segment, so moving a page between
 * groups changes its entry and neither its file nor its href, and nothing here
 * has to know which group a page sits in. A dynamic (`[id]`), parallel
 * (`@slot`) or intercepting segment fails by name rather than being matched
 * literally. An entry for `/admin/forms/[id]` would be a sidebar link to a page
 * called `[id]`, and how a detail page reached from its list should be held to
 * a key (its parent's, presumably) is a decision for whoever adds the first
 * one, made here in the same change.
 *
 * Both files are read with the compiler's parser, not run and not matched with
 * patterns, for the reason `dom-title.mjs` gives: comments are trivia in the
 * tree, so a key in a comment counts for nothing, and a call is a node, so
 * `can(agent, 'admin.x')` is never mistaken for the guard. The map cannot be
 * imported here (it is TypeScript, importing through the `@/` alias Node does
 * not resolve), so it is read as written, and an entry this cannot read — a key
 * or an href held in a variable, an entry spread in from elsewhere, a page
 * without its key — fails by name rather than passing unread. What it cannot
 * see is a guard on one branch of the page and not another: every `require*`
 * call in the page is held to the map, so a second one naming another key
 * fails, but a page that returns early before its only one passes.
 */

const REGISTRY = 'app/(console)/admin/sections.ts';
const PAGE = /^app\/\(console\)\/admin\/(?:.*\/)?page\.tsx$/;
const HOME = '/admin';

/** The guards a page opens with, and the shape of key each takes. */
const GUARDS = new Map([
  ['requirePermission', 'one'],
  ['requireAnyPermission', 'any'],
]);

/** `(console)` and its kind; not `(.)photo`, which intercepts and is in the URL. */
const ROUTE_GROUP = /^\((?!\.)[^()]+\)$/;
const PLAIN_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function checkAdminSections() {
  const rule = 'admin-sections';

  if (!scannable.includes(REGISTRY)) {
    fail(
      rule,
      REGISTRY,
      'the settings map is missing — the sidebar, the settings home and its search are drawn from it, so there is nothing to hold the settings pages to',
    );
    return;
  }

  const entries = readRegistry(rule);
  if (entries === null) return;
  if (
    !requireAtLeast(
      rule,
      REGISTRY,
      entries.length,
      15,
      'settings pages registered in ADMIN_SECTIONS',
    )
  ) {
    return;
  }

  const files = scannable.filter((f) => PAGE.test(f));
  if (!requireAtLeast(rule, 'app/(console)/admin/', files.length, 15, 'settings page.tsx files')) {
    return;
  }

  const pages = new Map();
  for (const file of files) {
    const { route, unsupported } = routeOf(file);
    if (unsupported) {
      fail(
        rule,
        file,
        `the segment '${unsupported}' is dynamic, parallel or intercepting, which admin-sections does not read — it holds a page's path to an href exactly, and an entry naming '${unsupported}' would be a sidebar link to nowhere; decide which key holds such a page (its parent's, presumably) and teach the rule in the same change`,
      );
      continue;
    }
    pages.set(route, file);
  }

  const byHref = new Map();
  for (const entry of entries) {
    const first = byHref.get(entry.href);
    if (first) {
      fail(
        rule,
        `${REGISTRY}:${entry.line}`,
        `${entry.href} is registered twice (first on line ${first.line}) — the sidebar draws the link twice and lights both, and the two entries can disagree about who is shown it; keep one`,
      );
      continue;
    }
    byHref.set(entry.href, entry);
  }

  for (const entry of byHref.values()) {
    const parent = entry.parent;
    if (!parent || !entry.permission || !parent.permission) continue;
    const uncovered = entry.permission.keys.filter((key) => !parent.permission.keys.includes(key));
    if (uncovered.length === 0) continue;
    fail(
      rule,
      `${REGISTRY}:${entry.line}`,
      `${entry.href} opens to ${uncovered.map((key) => `'${key}'`).join(', ')}, which its parent ${parent.href} does not — the sidebar draws a child only under a parent its reader may open, so whoever holds that key alone is let in and never shown the way; give the parent the key too, or make the page an entry of its own`,
    );
  }

  for (const entry of byHref.values()) {
    if (pages.has(entry.href)) continue;
    fail(
      rule,
      `${REGISTRY}:${entry.line}`,
      `${entry.href} has no page — no app/(console)/admin/**/page.tsx serves it, so the sidebar and the settings home link to a 404; remove the entry, or give it the page's new path`,
    );
  }

  for (const [route, file] of pages) {
    if (route === HOME) continue;
    const entry = byHref.get(route);
    if (!entry) {
      fail(
        rule,
        file,
        `${route} is not on the settings map — sections.ts draws the sidebar, the phone strip, the settings home and its search, so a page missing from it is a page nobody can find; give it an entry under its group, or as a child of the page that links to it`,
      );
      continue;
    }
    // An unreadable key was reported where the map spells it.
    if (entry.permission !== null) checkGuards(rule, file, entry);
  }
}

/**
 * Every entry in `ADMIN_SECTIONS` — an object literal naming an `href` or a
 * `permission`, at whatever depth — with its key, or null where the map cannot
 * be found at all. What cannot be read is reported here, once.
 */
function readRegistry(rule) {
  const source = parseSource(REGISTRY);
  const initializer = declarationOf(source, 'ADMIN_SECTIONS');
  if (!initializer) {
    fail(
      rule,
      REGISTRY,
      'could not find `export const ADMIN_SECTIONS = [...]` — the map is read as written, so a renamed or reshaped declaration leaves every settings page unchecked; update admin-sections in the same change',
    );
    return null;
  }

  const unreadable = (node, what) =>
    fail(
      rule,
      `${REGISTRY}:${lineOfNode(source, node)}`,
      `${what} — the map is read as written, not run, so an entry this cannot read is one it cannot hold to its page; spell it out in the list, as the others are`,
    );

  // A list held in a variable or spread in from one is a set of entries
  // nothing here can see, so it is refused rather than skipped.
  const inlineList = (node, name) => {
    const list = unwrap(node);
    if (!ts.isArrayLiteralExpression(list)) {
      unreadable(node, `\`${name}\` is \`${node.getText(source)}\`, not a list written out`);
      return;
    }
    for (const element of list.elements) {
      if (!ts.isObjectLiteralExpression(unwrap(element))) {
        unreadable(element, `\`${name}\` holds \`${element.getText(source)}\`, not an entry`);
      }
    }
  };

  const entries = [];
  const entryOf = new Map();
  const readEntry = (object) => {
    const href = valueOf(object, 'href');
    const permission = valueOf(object, 'permission');
    if (!href) {
      unreadable(object, 'an entry with a permission and no href');
      return;
    }
    const path = stringOf(unwrap(href));
    if (path === null) {
      unreadable(href, `an href written as \`${href.getText(source)}\`, not a quoted path`);
      return;
    }
    let keys = null;
    if (!permission) {
      unreadable(object, `${path} has no permission on its entry`);
    } else {
      keys = keysOf(permission);
      if (keys === null) {
        unreadable(
          permission,
          `${path}'s permission is \`${permission.getText(source)}\`, neither a quoted key nor a list of them`,
        );
      }
    }
    // The tree is walked parent first, so a child's parent is already read.
    const read = {
      href: path,
      permission: keys,
      line: lineOfNode(source, href),
      parent: entryOf.get(parentEntryOf(object)) ?? null,
    };
    entryOf.set(object, read);
    entries.push(read);
  };

  inlineList(initializer, 'ADMIN_SECTIONS');
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && ['pages', 'children'].includes(nameOf(node))) {
      inlineList(node.initializer, nameOf(node));
    }
    if (
      ts.isObjectLiteralExpression(node) &&
      (valueOf(node, 'href') !== undefined || valueOf(node, 'permission') !== undefined)
    ) {
      readEntry(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(initializer);

  return entries;
}

/** Holds every guard call in `file` to the key its entry names. */
function checkGuards(rule, file, entry) {
  const source = parseSource(file);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (GUARDS.has(name)) calls.push({ node, name });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (calls.length === 0) {
    fail(
      rule,
      file,
      `${entry.href} is registered under ${keyText(entry.permission)}, but its page calls neither requirePermission nor requireAnyPermission, so it is held to no key of its own while the sidebar offers it only to that one; call ${callText(entry.permission)}`,
    );
    return;
  }

  for (const { node, name } of calls) {
    const where = `${file}:${lineOfNode(source, node)}`;
    const argument = node.arguments[0];
    const found = argument ? keysOf(argument) : null;
    if (found === null || found.kind !== GUARDS.get(name)) {
      fail(
        rule,
        where,
        `${entry.href}'s page calls ${name}(${argument ? argument.getText(source) : ''}), which admin-sections cannot read — spell the key out, as ${callText(entry.permission)}, so it can be held to the map's ${keyText(entry.permission)}`,
      );
      continue;
    }
    if (sameKeys(found, entry.permission)) continue;
    fail(
      rule,
      where,
      `${entry.href} is registered under ${keyText(entry.permission)}, but its page calls ${callText(found)} — the sidebar shows a link only to whoever the map says may open it, so this is a link that answers "forbidden" or a page somebody it admits is never shown; make sections.ts and the page name the same key`,
    );
  }
}

/** A page's route, or the first segment that makes it more than a path. */
function routeOf(file) {
  const kept = [];
  for (const segment of file.split('/').slice(1, -1)) {
    if (ROUTE_GROUP.test(segment)) continue;
    if (!PLAIN_SEGMENT.test(segment)) return { unsupported: segment };
    kept.push(segment);
  }
  return { route: `/${kept.join('/')}` };
}

/** The entry whose `children` list holds `object`, if it is a child. */
function parentEntryOf(object) {
  const list = outermost(object).parent;
  if (!list || !ts.isArrayLiteralExpression(list)) return undefined;
  const holder = outermost(list).parent;
  return holder && ts.isPropertyAssignment(holder) && nameOf(holder) === 'children'
    ? holder.parent
    : undefined;
}

/** `node` with whatever `unwrap` would have looked through around it. */
function outermost(node) {
  let current = node;
  while (current.parent && unwrap(current.parent) !== current.parent) current = current.parent;
  return current;
}

function declarationOf(source, name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer ?? null;
      }
    }
  }
  return null;
}

/** `'k'` as `{ kind: 'one' }`, `['a', 'b']` as `{ kind: 'any' }`, else null. */
function keysOf(node) {
  const value = unwrap(node);
  const one = stringOf(value);
  if (one !== null) return { kind: 'one', keys: [one] };
  if (!ts.isArrayLiteralExpression(value) || value.elements.length === 0) return null;
  const keys = value.elements.map((element) => stringOf(unwrap(element)));
  return keys.every((key) => key !== null) ? { kind: 'any', keys } : null;
}

function sameKeys(a, b) {
  if (a.kind !== b.kind) return false;
  const left = new Set(a.keys);
  const right = new Set(b.keys);
  return left.size === right.size && [...left].every((key) => right.has(key));
}

function keyText({ kind, keys }) {
  return kind === 'one' ? `'${keys[0]}'` : `[${keys.map((key) => `'${key}'`).join(', ')}]`;
}

function callText(permission) {
  return permission.kind === 'one'
    ? `requirePermission(${keyText(permission)})`
    : `requireAnyPermission(${keyText(permission)})`;
}

/**
 * A property's value node: the initializer, the name of a shorthand (which is
 * a variable, and so unreadable), or undefined when the object has none.
 */
function valueOf(object, name) {
  for (const property of object.properties) {
    if (nameOf(property) !== name) continue;
    if (ts.isPropertyAssignment(property)) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property)) return property.name;
  }
  return undefined;
}

function nameOf(property) {
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function stringOf(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** `as const`, `satisfies`, parentheses and `!` change no value. */
function unwrap(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}
