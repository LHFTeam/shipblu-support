import { fail, read, scannable, stripComments, requireAtLeast } from '../lib.mjs';

/**
 * A console page brings its own scroll container (§6.53).
 *
 * The shell in `app/(console)/layout.tsx` is `h-dvh overflow-hidden` with a
 * `min-h-0 flex-1` content column, so that the inbox can own the full height and
 * manage its own panes. The price is that a page which does not open an
 * `overflow-y-auto` wrapper is not merely unpadded: everything below the fold is
 * rendered where nobody can scroll to it, and the page reads as half-finished
 * rather than broken. `/reports/categories` shipped that way and was caught by a
 * person; the four `/contacts` pages shipped that way and were caught by an
 * audit reading the code, which is the reason this is now a check.
 *
 * Two things satisfy it, and neither is a list of exempt files. `admin/` pages
 * get the wrapper from `admin/layout.tsx`, so they are not scanned. And a page
 * that renders `<InboxShell>` is handing the height to the one component that
 * lays out its own panes — the inbox list and the ticket view scroll inside
 * those. Anything else must say `overflow-y-auto` itself.
 *
 * What it checks is presence in the file, not a wrapper on every rendered
 * branch. A page whose success branch carries the wrapper passes even if an
 * early return does not — `/inbox/new` returns a bare `p-6` for its two
 * "not configured" states, which is fine only because each is a single short
 * message. An early return must stay that short or carry the wrapper too;
 * following each branch would need a JSX parser, and a regex that pretended to
 * would be worse than one that says what it does not see.
 */
export function checkConsolePagesScroll() {
  const rule = 'console-scroll';

  const pages = scannable.filter(
    (f) =>
      /^app\/\(console\)\/(?:.*\/)?page\.tsx$/.test(f) && !f.startsWith('app/(console)/admin/'),
  );
  if (!requireAtLeast(rule, 'app/(console)/', pages.length, 8, 'console pages outside admin/')) {
    return;
  }

  for (const page of pages) {
    const contents = stripComments(read(page));
    if (/\boverflow-y-auto\b/.test(contents) || /<InboxShell\b/.test(contents)) continue;
    fail(
      rule,
      page,
      'no scroll container — the console shell clips its content column, so everything below the fold is unreachable; wrap the page in `app-scroll h-full overflow-y-auto p-6` (AGENTS.md, §6.53)',
    );
  }
}
