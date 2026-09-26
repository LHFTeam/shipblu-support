import {
  fail,
  tracked,
  scannableSource,
  lineOf,
  scan,
  directiveOf,
  requireAtLeast,
} from '../lib.mjs';

/**
 * Where a server action may live: `actions.ts`, or a `<domain>-actions.ts`
 * sibling, anywhere under app/.
 *
 * The second spelling is not hypothetical. `admin/settings-actions.ts` has used
 * it since it was written, and the first version of this check matched only
 * `actions.ts`, so that file's directive was never checked. Deleting it was
 * still caught, but only by accident: client-bundle fired because the admin
 * forms that import the file then reached `db/schema`, and it said so in terms
 * of the bundle rather than the directive. An action file no client form
 * imports would have gone through clean. `plans/refactor-in-stages.md` splits
 * the two large action files into more `*-actions.ts` siblings, which would
 * have widened that gap one file at a time.
 */
const ACTION_FILE = /^app\/(?:.*\/)?(?:[a-z0-9-]+-)?actions\.ts$/;

/**
 * Two directions, because either half alone leaves an endpoint nobody reviews.
 *
 * Every export of a `'use server'` module is published by Next as a POST
 * endpoint anyone can call with any arguments. That is why AGENTS.md asks every
 * action to authorise and to re-read ids rather than trust them — and a reviewer
 * applies that scrutiny to files that look like actions. So:
 *
 * - an action file must carry the directive, or it is not what its name says;
 * - a module that carries the directive must be named as an action file, and a
 *   `'use server'` anywhere else — a lib/ helper, or one inlined into a page's
 *   function body — fails, because it publishes endpoints from a file nobody
 *   reads as a list of endpoints.
 *
 * `lib/automations/actions.ts` shares the name and is not a server action: it is
 * the automation engine's rule actions. The first direction is scoped to app/ so
 * it is left alone, and the second would catch it the day it grew a directive.
 */
export function checkServerActions() {
  const rule = 'server-actions';

  const actionFiles = tracked.filter((f) => ACTION_FILE.test(f));
  if (!requireAtLeast(rule, 'app/', actionFiles.length, 5, 'server action files')) return;

  for (const file of actionFiles) {
    if (directiveOf(file) !== 'server') {
      fail(rule, file, "a server action file must start with 'use server'");
    }
  }

  scan(
    scannableSource.filter((f) => /\.tsx?$/.test(f)),
    // Only where a directive can stand: first in the file, or first in a
    // function body. The same words anywhere else are a string — a constant, a
    // test naming the directive — and publish nothing. `contents` has its
    // comments blanked, so a directive below a header comment still follows
    // nothing but whitespace.
    /(^\s*|\{\s*)(['"])use server\2/g,
    (file, _line, match, contents) => {
      const isFileDirective = !match[1].includes('{');
      if (isFileDirective && ACTION_FILE.test(file)) return;
      fail(
        rule,
        `${file}:${lineOf(contents, match.index + match[1].length)}`,
        isFileDirective
          ? "a 'use server' module must be named actions.ts or <domain>-actions.ts under app/ — every export of it is a public POST endpoint, and reviewers look for those in action files"
          : "an inline 'use server' publishes a POST endpoint from inside another file — move the action into an actions.ts beside it",
      );
    },
  );
}
