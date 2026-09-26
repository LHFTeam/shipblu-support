import {
  fail,
  scannableSource,
  resolveModule,
  moduleEdges,
  directiveOf,
  requireAtLeast,
} from '../lib.mjs';

// ---------------------------------------------------------------------------
// The browser bundle: no client component reaches the database, however
// indirectly
//
// AGENTS.md splits `lib/forms/files.ts` from `lib/forms/attachments.ts` by which
// side of the wire runs it, and `lib/kb/floors.ts` from `lib/kb/internal.ts` for
// the same reason. The first split had to be made because `node:fs` in the
// browser bundle is a build error. The second had no such backstop: three
// console components imported one label map from a module that value-imports
// `@/db/schema`, and Next shipped the whole Drizzle schema — 87 KB of table
// definitions no browser executes — in the first-load JS of `/kb/[id]`,
// `/kb/new` and `/kb/structure`. Nothing failed. Only a bundle report showed it.
//
// So the graph is walked here rather than trusted to review. A `'use client'`
// file is an entry point, and anything it can reach through a value import is
// in the bundle; `import type` is erased by tsc and is followed by nobody.
// ---------------------------------------------------------------------------
export function checkClientBundleStaysOutOfTheDatabase() {
  const rule = 'client-bundle';

  /** `@/x` is the repo root, and a relative specifier is relative to the file. */
  /** The modules that must never be in a browser bundle, and why. */
  const FORBIDDEN = [
    ['db/schema', 'the Drizzle table definitions — 87 KB of SQL builders no browser runs'],
    ['db/client', 'the database pool'],
  ];

  const entries = scannableSource.filter(
    (file) => /\.tsx?$/.test(file) && directiveOf(file) === 'client',
  );
  if (!requireAtLeast(rule, '(repository)', entries.length, 20, "'use client' entry points")) {
    return;
  }

  for (const entry of entries) {
    // Breadth-first, remembering how each module was reached: an error saying
    // "editor.tsx → lib/kb/internal.ts → db/schema" is fixable, and "something
    // in the console imports the schema" is not.
    const seen = new Set([entry]);
    const queue = [[entry]];

    while (queue.length > 0) {
      const trail = queue.shift();
      const file = trail[trail.length - 1];

      for (const edge of moduleEdges(file)) {
        // Imports only, and value imports only: `import type` is erased, and a
        // re-export is not something the entry pulls into its own bundle.
        if (edge.kind !== 'import' || edge.typeOnly) continue;
        const target = resolveModule(edge.spec, file);
        if (target === null || seen.has(target)) continue;
        seen.add(target);

        // A `'use server'` module is a boundary rather than a dependency: Next
        // replaces each export with a fetch to the server, so what it imports
        // never reaches the browser. Every client form in this repo imports its
        // own actions file, and following that edge would report the whole
        // console.
        if (directiveOf(target) === 'server') continue;

        const forbidden = FORBIDDEN.find(([prefix]) => target.startsWith(prefix));
        if (forbidden) {
          fail(
            rule,
            `${entry}`,
            `reaches ${forbidden[0]} — ${forbidden[1]} — via ${[...trail.slice(1), target].join(' → ') || target}; ` +
              'split the client-safe half into its own module, as lib/kb/floors.ts is split from lib/kb/internal.ts',
          );
          continue;
        }

        queue.push([...trail, target]);
      }
    }
  }
}
