import {
  directiveOf,
  fail,
  lineOf,
  read,
  scannable,
  stripComments,
  requireAtLeast,
} from '../lib.mjs';

/**
 * A page never imports the database client, directly or through a module
 * beside it.
 *
 * A page is where a query is first run in production: no static check reads
 * the SQL a Drizzle builder or a raw `sql` fragment emits, and the `database`
 * CI job runs job handlers and `*.db.test.ts`, not pages. So a query written
 * in a page is tested by whoever opens it next. Stage 5.4 of
 * `plans/refactor-in-stages.md` moved every page's queries into `lib/`, where a
 * `*.db.test.ts` can reach them (`lib/admin/settings.ts`,
 * `lib/admin/import-status.ts`, `lib/auth/invites.ts` and the rest); this keeps
 * the next one from being written inline.
 *
 * So it reads every module under `app/` that a page can reach, not only the
 * `page.tsx` files: a helper beside the page is the same query one import away,
 * and `admin/field-options.ts` was exactly that until #266 (review on #277).
 * `layout.tsx`, `template.tsx` and `default.tsx` are Server Components too.
 * Three kinds of module under `app/` are not pages and may hold a query:
 * server actions (`'use server'`), whose writes are the point of them; route
 * handlers (`route.ts`); and tests.
 *
 * It checks `db/client` only. A module importing a table from `db/schema` for a
 * type, or a vocabulary, runs no query; the client is the thing that does.
 *
 * One page is exempt, by name, and the check fails if the exemption stops being
 * needed. `app/probe/page.tsx` exists to prove that a Server Component can
 * reach the database — `/api/health` renders it, and Render restarts an
 * instance only when that check fails — so the database probe is the page's
 * entire job, and moving it behind `lib/` would test a different path from the
 * one that hangs.
 */
const EXEMPT = new Map([
  ['app/probe/page.tsx', 'the render probe: reaching the database from a page is what it tests'],
]);

const CLIENT_IMPORT = /['"](?:@\/|(?:\.\.?\/)+)db\/client['"]/;

export function checkPagesDoNotImportTheDatabase() {
  const rule = 'page-db';

  const modules = scannable.filter(
    (f) =>
      /^app\/.*\.tsx?$/.test(f) &&
      !/\.test\.tsx?$/.test(f) &&
      !/(?:^|\/)route\.ts$/.test(f) &&
      directiveOf(f) !== 'server',
  );
  const pages = modules.filter((f) => /(?:^|\/)page\.tsx$/.test(f));
  if (!requireAtLeast(rule, 'app/', pages.length, 40, 'page.tsx files')) return;

  for (const file of modules) {
    const contents = stripComments(read(file));
    const match = CLIENT_IMPORT.exec(contents);

    if (EXEMPT.has(file)) {
      if (!match) {
        fail(
          rule,
          file,
          `exempt from page-db (${EXEMPT.get(file)}) but no longer imports db/client — remove it from EXEMPT so the exemption cannot cover a query added later`,
        );
      }
      continue;
    }

    if (match) {
      fail(
        rule,
        `${file}:${lineOf(contents, match.index)}`,
        'imports db/client — move the query into lib/<domain>/, where a *.db.test.ts can run it, and call that from the page or component (AGENTS.md, Layout; plans/refactor-in-stages.md §5.4)',
      );
    }
  }

  for (const page of EXEMPT.keys()) {
    if (!pages.includes(page)) {
      fail(rule, page, 'exempt from page-db but no such page — remove it from EXEMPT');
    }
  }
}
