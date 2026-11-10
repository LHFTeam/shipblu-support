import { fail, lineOf, read, requireAtLeast, scannableSource, stripComments } from '../lib.mjs';

/** Where `articleBody` is defined, and so called by nothing it must answer for. */
const DEFINITION = 'lib/kb/article-write.ts';

/**
 * Every body written into `kb_articles` is pointed off Freshdesk before it is
 * written: each `articleBody(` call is followed by a `pointedHere(` before the
 * next one, or before the module ends.
 *
 * `articleBody` is the one way a body is made fit to store (sanitised, then
 * normalised, with its text derived), so a module that calls it is writing an
 * article. `pointedHere` (`lib/kb/off-freshdesk.ts`) sends a picture
 * `rehost_kb_images` copied to its copy, and a link to an imported article to
 * that article. A writer that skips it can put Freshdesk's addresses back after
 * the copy job and the formatting pass took them out: a Restore of an old
 * version, a re-import, a paste from the old portal. Nothing downstream would
 * notice until the day Freshdesk is disconnected and those pictures and links
 * break. The Save that refuses what is left (`saveRefusal`) reads the pointed
 * body, so it cannot stand in for this either.
 *
 * Asked of the module rather than traced through the code, as the
 * sanitise-then-normalise pair is (`article-normalisation`): a `pointedHere`
 * between one `articleBody` and the next is what every writer has, and a
 * second write path added beside the first, without one, is what this catches.
 */
export function checkArticleOffFreshdesk() {
  let writers = 0;

  for (const file of scannableSource) {
    if (file === DEFINITION || /\.test\.[cm]?[jt]sx?$/.test(file)) continue;

    const source = stripComments(read(file));
    const calls = [...source.matchAll(/\barticleBody\(/g)].map((match) => match.index);
    if (calls.length === 0) continue;
    writers += 1;

    const pointed = [...source.matchAll(/\bpointedHere\(/g)].map((match) => match.index);
    calls.forEach((at, i) => {
      const next = calls[i + 1] ?? source.length;
      if (pointed.some((p) => p > at && p < next)) return;
      fail(
        'article-off-freshdesk',
        `${file}:${lineOf(source, at)}`,
        'makes an article body with articleBody() and never points it off Freshdesk — ' +
          'pass its bodyHtml through pointedHere() (lib/kb/off-freshdesk.ts) before writing it',
      );
    });
  }

  // Three today: the console's actions (Save and Restore), the import and the
  // handbook seed. Fewer means the pattern stopped matching the code, not that
  // the writers went away.
  requireAtLeast('article-off-freshdesk', DEFINITION, writers, 2, 'modules calling articleBody()');
}
