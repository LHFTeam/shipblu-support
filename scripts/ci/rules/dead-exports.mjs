import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  fail,
  scannableSource,
  lineOf,
  stripComments,
  resolveModule,
  moduleEdges,
  directiveOf,
  requireAtLeast,
} from '../lib.mjs';

// ---------------------------------------------------------------------------
// Exports nothing imports
//
// AGENTS.md: "When you learn something durable ... prefer a check in
// scripts/ci/repo-rules.mjs over a paragraph here."
//
// plans/query-optimisation-and-cleanup.md scanned for these by hand, found "a
// crude scan suggested 40", verified them one at a time, and asked for the
// check to be made mechanical so the next session would not redo the scan. It
// was redone anyway, and turned up twenty-seven: nine unused icons, a server
// action no form submits, and four functions whose doc comments described
// callers that do not exist — `onInboundMessage` called itself "the single call
// every inbound path makes" while no path made it.
//
// That last kind is why this is worth a check rather than a cleanup. Dead code
// costs nothing to execute; a dead function with a confident comment costs the
// next reader their afternoon, because it reads as the system's behaviour.
//
// **It asks the module graph, not the text.** The first version counted bare
// identifiers across the repo and called an export live if the token appeared
// anywhere else. That is not the question: `lib/portal/tickets.ts` exported a
// dead `contactName` that no file imported, and the count exempted it because
// `contactName` is an ordinary object key elsewhere — as `status`, `config`,
// `preview` and `handler` would be. A check that certifies a file clean while
// the defect is still in it is worse than no check, because §6.63 tells the
// next session the scan is mechanical. So an export is live when some other
// module names it in an `import` or a re-export, and nothing else counts.
//
// Values only — a function, const, class or enum. An exported *type* is not
// checked: annotating a return with a named exported type is good practice
// here, and the great majority of them are referenced only from the signature
// they describe, so flagging those would push the codebase to un-export shapes
// that callers legitimately need to name.
// ---------------------------------------------------------------------------

/**
 * Names the framework imports by calling convention rather than by reference,
 * each only in the kind of file the framework looks for it in.
 *
 * Scoping matters: `config`, `metadata` and `dynamic` are ordinary names for a
 * lib-level constant, and exempting them everywhere would hide real dead code
 * in exactly the modules this rule is most needed in.
 */
const ROUTE_HANDLERS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const SEGMENT_CONFIG = new Set([
  'generateStaticParams',
  'generateMetadata',
  'generateViewport',
  'metadata',
  'viewport',
  'dynamic',
  'dynamicParams',
  'revalidate',
  'runtime',
  'fetchCache',
  'preferredRegion',
  'maxDuration',
  'experimental_ppr',
]);

/** Next's own file names for a route segment. */
const SEGMENT_FILE =
  /(^|\/)(page|layout|route|template|default|loading|error|not-found|global-error)\.tsx?$/;

/** The entry points Next loads by path rather than by import. */
const FRAMEWORK_ENTRY = new Map([
  ['proxy.ts', new Set(['config', 'proxy', 'middleware'])],
  ['middleware.ts', new Set(['config', 'middleware'])],
  ['instrumentation.ts', new Set(['register', 'onRequestError'])],
]);

const VALUE_EXPORT =
  /^export\s+(?:async\s+)?(?:function\*?|const|let|var|abstract\s+class|class|enum)\s+([A-Za-z0-9_$]+)/gm;

function frameworkOwns(file, name) {
  if (FRAMEWORK_ENTRY.get(file)?.has(name)) return true;
  if (!file.startsWith('app/')) return false;
  if (/(^|\/)route\.tsx?$/.test(file) && ROUTE_HANDLERS.has(name)) return true;
  return SEGMENT_FILE.test(file) && SEGMENT_CONFIG.has(name);
}

export function checkNoDeadExports() {
  const rule = 'dead-exports';

  const files = scannableSource.filter(
    (f) => /\.(ts|tsx|mts|mjs)$/.test(f) && !f.endsWith('.d.ts'),
  );

  // What every module has pulled out of every other, by name.
  const importedFrom = new Map();
  const opaque = new Set();

  for (const file of files) {
    for (const edge of moduleEdges(file)) {
      const target = resolveModule(edge.spec, file);
      if (target === null) continue;

      // Nothing can be said about a module reached without naming what it
      // exports — a namespace import, a wholesale re-export, a dynamic import.
      if (edge.namespace) {
        opaque.add(target);
        continue;
      }

      if (!importedFrom.has(target)) importedFrom.set(target, new Set());
      for (const name of edge.names) importedFrom.get(target).add(name);
    }
  }

  // The floor goes on what VALUE_EXPORT selects, not on the file list: git will
  // always hand back hundreds of files, and it is the export pattern that can
  // go blind. Broken on purpose, it matched nothing and the check reported a
  // clean tree — which is the one failure this guard exists for.
  let examined = 0;

  for (const file of files) {
    if (opaque.has(file)) continue;

    const contents = stripComments(readFileSync(path.join(ROOT, file), 'utf8'));
    const importers = importedFrom.get(file) ?? new Set();
    const isServerModule = directiveOf(file) === 'server';

    VALUE_EXPORT.lastIndex = 0;
    let match;
    while ((match = VALUE_EXPORT.exec(contents)) !== null) {
      examined += 1;
      const name = match[1];
      if (importers.has(name) || frameworkOwns(file, name)) continue;

      // Used in its own module and merely over-exported, which is a much
      // smaller thing than being uncalled — except in a `'use server'` file,
      // where an export is not a symbol at all: Next publishes each one as a
      // POST endpoint, so one nothing imports is a live route with no caller
      // and no page behind it. Nothing in this repo relies on that exemption
      // today; it exists so the rule does not demand a refactor of every module
      // that exports a helper it also uses.
      const usedHere = (contents.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length > 1;
      if (usedHere && !isServerModule) continue;

      fail(
        rule,
        `${file}:${lineOf(contents, match.index)}`,
        isServerModule
          ? `${name} is a server action nothing imports — Next still publishes it as a POST endpoint, so delete it or put it behind a form in the same commit`
          : `${name} is exported and no module imports it — delete it, or if it is a capability worth keeping, wire it up in the same commit`,
      );
    }
  }

  requireAtLeast(rule, '(repository)', examined, 300, 'value exports');
}
