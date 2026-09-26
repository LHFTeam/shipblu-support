import { fail, read, scannable, scannableSource, lineOf, scan } from '../lib.mjs';

/**
 * One palette. The app is light-only, everywhere, whatever the reader's
 * operating system asks for.
 *
 * This is a check rather than a sentence because a dark theme comes back one
 * utility at a time. A dark-variant colour appended to a class list is
 * invisible in review — it is a colour nobody looking at the page can see — and
 * the moment the first `@media (prefers-color-scheme: dark)` block returns,
 * every one of them wakes up at once against tokens that were never re-stepped
 * for a dark surface. Half a theme is worse than none: light text on the light
 * `--surface` that is still what `:root` resolves to.
 *
 * Note the phrasing above: this file is scanned by Tailwind like any other, so
 * spelling a complete variant class in a comment here — even to explain why it
 * is banned — emits that utility into the served stylesheet.
 *
 * Three things, then. No media query answering the OS preference, no Tailwind
 * `dark:` variant (which is that same media query spelled shorter), and the
 * `color-scheme: light` that pins the surfaces the browser paints itself — a
 * select's dropdown, the form-control chrome, the default scrollbar. That
 * declaration is the only part a stylesheet cannot express by omission, so its
 * absence is a failure rather than a preference.
 *
 * If a dark theme is ever wanted, it is a piece of work — re-step the tokens,
 * decide whether the help centre follows the console, check the chart series
 * against the new surfaces — and this rule comes out in that commit.
 */
export function checkLightOnly() {
  const rule = 'light-only';

  // CSS comments carry the reasoning, including the words below. Blanked the
  // same way stripComments blanks a JS comment, newlines kept so a line number
  // still points somewhere.
  const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  for (const file of scannable.filter((f) => f.endsWith('.css'))) {
    const css = stripCss(read(file));
    for (const match of css.matchAll(/prefers-color-scheme/g)) {
      fail(
        rule,
        `${file}:${lineOf(css, match.index)}`,
        'the app is light-only — a dark block here re-enables half a theme against tokens stated for light surfaces',
      );
    }
  }

  scan(scannableSource, /(?:^|[\s'"`{(])dark:[a-z[]/g, (file, line) => {
    fail(
      rule,
      `${file}:${line}`,
      "Tailwind's dark: variant is prefers-color-scheme by another name — drop the override and keep the light value",
    );
  });

  const globals = stripCss(read('app/globals.css'));
  if (!/:root\s*\{[^}]*color-scheme:\s*light/.test(globals)) {
    fail(
      rule,
      'app/globals.css',
      'color-scheme: light is gone from :root — the browser paints its own controls and scrollbars dark again on a light page',
    );
  }
}
