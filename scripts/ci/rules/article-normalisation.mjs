import { fail, read, scannableSource } from '../lib.mjs';

/**
 * An article body that is sanitised on write is also normalised on write.
 *
 * The two belong together and in that order: `sanitiseArticleHtml` is the
 * security boundary and `normaliseArticleHtml` is the formatting standard the
 * help centre's stylesheet assumes. A write path that sanitises and forgets to
 * normalise stores an article carrying whatever the author's clipboard brought
 * with it — four editors' classes, inline colours that override the article
 * palette, and body `h1`s that render as plain text — and nothing downstream
 * notices, because the page renders the row it is given.
 *
 * Checked as a pair rather than by asking for the call, because the ordering is
 * the part that is easy to get wrong and impossible to see later.
 */
export function checkArticleNormalisation() {
  for (const file of scannableSource) {
    if (file === 'lib/kb/format.ts' || file.endsWith('.test.ts')) continue;

    const source = read(file);
    if (!source.includes('sanitiseArticleHtml(')) continue;
    if (file === 'lib/html/sanitize.ts') continue;

    if (!source.includes('normaliseArticleHtml(')) {
      fail(
        'article-normalisation',
        file,
        'sanitises an article body but never normalises it — wrap the call as ' +
          'normaliseArticleHtml(sanitiseArticleHtml(html)); lib/kb/format.ts says why',
      );
      continue;
    }

    for (const match of source.matchAll(/sanitiseArticleHtml\(([^)]*)\)/g)) {
      const before = source.slice(0, match.index);
      const wrapped = /normaliseArticleHtml\(\s*$/.test(before);
      if (!wrapped) {
        fail(
          'article-normalisation',
          `${file}:${before.split('\n').length}`,
          'sanitises an article body outside normaliseArticleHtml(...) — normalising ' +
            'first would hand the sanitiser markup this repo had already rewritten',
        );
      }
    }
  }
}
