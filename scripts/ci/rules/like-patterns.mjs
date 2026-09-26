import { fail, scannableSource, scan, requireAtLeast } from '../lib.mjs';

/**
 * Every LIKE pattern is built by `containing()` in `lib/search/like.ts`.
 *
 * `%` and `_` are wildcards to LIKE, so a pattern built as `%${value}%` from what
 * somebody typed searches for something else. The escaping was written once,
 * in the ticket search, and copied twice; the knowledge base admin search was
 * written without it and matched every article on a lone `%`. The contact
 * search then kept two hand-built patterns on the grounds that their value was
 * normalised — and normalising strips separators, not `%`, so both listed every
 * row as well. A rule in a comment above the builder did not stop either.
 *
 * The shape looked for is a template literal opening with `%${`. That is how
 * every hand-built pattern here was written; a percentage printed for a person
 * is `${value}%`, the other way round, and does not match.
 */
export function checkLikePatternsUseTheBuilder() {
  const rule = 'like-patterns';
  const builder = 'lib/search/like.ts';
  const sources = scannableSource.filter((f) => f !== builder);

  scan(sources, /`%\$\{/g, (file, line) => {
    fail(
      rule,
      `${file}:${line}`,
      "a hand-built LIKE pattern takes `%` and `_` in the value as wildcards — use containing() from '@/lib/search/like'",
    );
  });

  // The floor is on the builder's call sites: a rename of `containing` would
  // otherwise leave this check guarding a name nothing uses.
  let uses = 0;
  scan(
    sources.filter((f) => !/\.test\.tsx?$/.test(f)),
    /\bcontaining\(/g,
    () => {
      uses++;
    },
  );
  requireAtLeast(rule, builder, uses, 4, 'containing() call sites');
}
