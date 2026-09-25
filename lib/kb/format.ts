/**
 * The knowledge base's formatting standard, applied on write.
 *
 * Every article in this knowledge base was imported from Freshdesk, whose
 * editor stores whatever the browser's contenteditable produced and whatever an
 * author pasted into it. What arrived is therefore not one house style but four
 * at once: Froala's own `fr-fic fr-dib` image classes, Zoho Mail's `zw-*`
 * paragraph classes, a chunk of ChatGPT's DOM complete with `class="markdown
 * prose dark:prose-invert"`, and a WordPress theme's `fusion-text`.
 *
 * None of that is inert here. `.kb-article` in `app/globals.css` says it in as
 * many words — "it arrives as plain semantic tags with no classes of its own —
 * the styling has to hang off the element names" — and this app is built with
 * Tailwind, so `flex`, `flex-col`, `items-end`, `gap-2`, `text-lg` and
 * `mx-auto` are all real utilities in the served stylesheet. A pasted wrapper
 * carrying them turns part of an article into a flex column with its content
 * pushed to the inline end. Inline `color:` and `font-size` are the same shape
 * of problem one layer down: the help centre's type scale and text colour are
 * the stylesheet's, and a `rgb(0, 0, 0)` at `13px` carried over from whatever
 * editor the author pasted from overrides both — one paragraph in an article
 * rendering a size and a black the rest of the page never uses.
 *
 * So the standard is what the stylesheet already assumes, and this module is
 * where it is written down as code rather than as prose somebody has to
 * remember:
 *
 * 1. Block structure only: `p`, `ul`/`ol`/`li`, `h2`–`h6`, `blockquote`,
 *    `table`, `pre`, `img`, `a`, `strong`. No `div` or `span` — neither carries
 *    meaning, and both are how a paste smuggles a foreign layout in.
 * 2. **No `h1` in a body.** The article page renders the title as the page's
 *    `h1`, and `.kb-article` deliberately styles `h2`–`h6` only. Tailwind's
 *    preflight resets every heading to `font-size: inherit; font-weight:
 *    inherit`, so a body `h1` picks up nothing at all and renders as plain
 *    paragraph text. A section heading is an `h2`, a sub-section an `h3`.
 * 3. No `class` and no `style`. The article's appearance is the stylesheet's
 *    job; an inline size or colour can only disagree with it.
 * 4. No `dir` on individual elements. The help-centre shell sets `dir` once on
 *    its wrapper and every rule below it is logical (`padding-inline-start`,
 *    `text-align: start`), so Arabic mirrors without help — while a stray
 *    `dir="ltr"`, which 25 of the Arabic articles carry, un-mirrors one
 *    paragraph in the middle of a right-to-left page.
 * 5. `br` is a line break inside a paragraph, never spacing between blocks.
 *    Vertical rhythm is `.kb-article > * + *`; a run of nine `br`s and an empty
 *    `<p><br></p>` are an editor's way of typing Return, and they leave a gap
 *    the stylesheet then adds to.
 * 6. Emphasis is semantic: `strong` for it, never `u` — underline is the one
 *    thing `.kb-article a` uses, so underlined prose reads as a dead link.
 *
 * Two design notes, because both are load-bearing:
 *
 * **This runs after `sanitiseArticleHtml`, never instead of it and never
 * before.** That ordering is what makes a regex pass over markup defensible
 * rather than reckless: the input is always sanitize-html's own output, so tags
 * are lowercase, attributes are double-quoted, `br` and `img` are
 * `<br />`-style, and no attribute value can contain `<` or `>`. Sanitising is
 * still the security boundary and this is only a formatting pass — normalising
 * first would hand the sanitiser something this module had already rewritten.
 *
 * **Nothing here touches a text node.** Every pass matches tags and attributes;
 * no rule rewrites, folds, trims or re-encodes the words between them. That is
 * deliberate and worth keeping: half this content is Arabic, an article is the
 * answer a customer reads, and a normaliser that edits prose is a normaliser
 * that can silently damage it. The one exception is deletion of content that is
 * only markup — an empty paragraph, a run of `br`s — which removes no
 * characters a reader would have seen.
 */

/**
 * Elements that own their own vertical space, so a `br` at either edge of one
 * is spacing rather than a line break.
 *
 * `div` is here even though the standard forbids it: unwrapping happens in the
 * same pipeline and a `br` sitting at the edge of a `div` that is about to
 * disappear is the same artefact.
 */
const BLOCK_EDGE = 'p|li|h2|h3|h4|h5|h6|blockquote|td|th|div';

/** Blocks that are noise when they contain nothing but whitespace and `br`s. */
const EMPTIABLE = 'p|h2|h3|h4|h5|h6|li|ul|ol|blockquote|strong|em|b|i|div|span';

/**
 * Elements that start a new flow, so a `br` in front of one is spacing.
 *
 * Deliberately not `EMPTIABLE`, which is a list of things that can be *empty*
 * and includes `strong` and `span`. Reusing it here deleted the line break in
 * `14 days.<br /><br /><br /><strong>Invalid Orders:` and ran two sentences of
 * the claims procedure together — the run was somebody's paragraph break, and
 * collapsing it to one `br` keeps the break while dropping the padding.
 */
const BLOCK_OPEN = 'p|h2|h3|h4|h5|h6|ul|ol|li|blockquote|table|pre|hr|div|figure|dl';

const BR = '<br\\s*/?>';

/** Whitespace, `br`s and `img`s — the only things an image-only wrapper holds. */
const IMAGE_ONLY = `(?:\\s|${BR}|<img\\b[^>]*/?>)*`;

/**
 * Freshdesk's info callout, which it stores as a `pre`.
 *
 * `.kb-article pre` is the code-block style — monospaced, boxed, and
 * `direction: ltr` so a code sample reads left to right whatever the article
 * does. That last rule is why this cannot stay a `pre`: the Arabic callouts
 * render as right-to-left prose forced into left-to-right monospace. A note
 * beside the text is what `blockquote` is already styled as, so that is where
 * these go.
 */
const CALLOUT =
  /<pre\b[^>]*\bclass="[^"]*fd-callout[^"]*"[^>]*>((?:(?!<\/?pre\b)[\s\S])*)<\/pre>/gi;

/** Every `table` in the document, so each can be judged on what it holds. */
const TABLE = /<table\b[^>]*>(?:(?!<\/?table\b)[\s\S])*<\/table>/gi;
const CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
const IMG = /<img\b[^>]*\/?>/gi;

/**
 * A table used to put screenshots side by side.
 *
 * Freshdesk's editor offers no columns, so an author who wanted two images in a
 * row built a borderless table. `.kb-article` then draws borders on every `td`
 * and makes the table a horizontal scroll container, which is right for a table
 * of data and wrong for this: the reader gets a bordered box round two
 * screenshots that no longer fit side by side on a phone anyway.
 *
 * Only tables with no header cell and nothing but images inside are unwrapped.
 * A table with a `th`, or with a word in it, is a table.
 */
function unwrapImageTables(html: string): string {
  return html.replace(TABLE, (table) => {
    if (/<th\b/i.test(table)) return table;

    const cells = [...table.matchAll(CELL)].map((match) => match[1] ?? '');
    if (cells.length === 0) return table;

    const imageOnly = new RegExp(`^${IMAGE_ONLY}$`, 'i');
    if (!cells.every((cell) => imageOnly.test(cell) && /<img\b/i.test(cell))) return table;

    return cells
      .flatMap((cell) => cell.match(IMG) ?? [])
      .map((image) => `<p>${image}</p>`)
      .join('');
  });
}

/**
 * A `div` with no `div` inside it, so the innermost one is always rewritten
 * first and an outer one becomes innermost in the next pass.
 */
const INNERMOST_DIV = /<div\b[^>]*>((?:(?!<\/?div\b)[\s\S])*)<\/div>/gi;

/** Anything that makes its own block, used to tell a wrapper from a paragraph. */
const HOLDS_BLOCK = /<(?:p|ul|ol|li|h[2-6]|table|blockquote|pre|hr|figure|dl|dt|dd)\b/i;

/**
 * Unwraps the `div`s, but not all in the same way.
 *
 * A `div` around a list or a paragraph was only ever a wrapper, and its tags
 * come out. A `div` around a sentence or a screenshot *was* the block — that is
 * what a `div` does — so it becomes the paragraph it was standing in for.
 * Deleting both kinds outright is the version of this that was wrong: in the
 * account-creation article two sibling `div`s, one holding a screenshot and one
 * holding a sentence, came out as a single paragraph with the sentence
 * alongside the image instead of under it.
 *
 * Innermost first and repeated, because a `div` is only recognisable as a
 * wrapper once the `div`s inside it have gone.
 */
function unwrapDivs(html: string): string {
  let current = html;

  // One pass strips one level of nesting, so the bound is the number of `div`s
  // there were — a fixed constant is what left seven of them in the myBlu
  // article, whose pasted wrapper is fifteen deep.
  const passes = (html.match(/<div\b/gi) ?? []).length + 1;

  for (let pass = 0; pass < passes; pass += 1) {
    const next = current.replace(INNERMOST_DIV, (_match, inner: string) => {
      if (HOLDS_BLOCK.test(inner)) return inner;
      return inner.trim() ? `<p>${inner.trim()}</p>` : '';
    });

    if (next === current) return current;
    current = next;
  }

  return current;
}

/**
 * Collapses the spacing and wrapper artefacts, repeatedly.
 *
 * One pass is not enough, and the reason is structural rather than fussy. Two
 * examples, both from the corpus: a `<p><strong><br /><br /></strong></p>` —
 * five of which end the single-delivery-order guide — only becomes an empty
 * paragraph once the `strong` inside it has been recognised as empty and
 * removed; and a `<strong><br /><br /><img /></strong>` is only an image-only
 * wrapper after the `br`s have gone. Each pass can expose work for the next, so
 * this runs to a fixed point, and every rule that can be exposed by another
 * lives inside the loop rather than before it.
 *
 * Bounded rather than `while (true)`: the passes only ever delete, so they must
 * converge, but a bound means a future pass that accidentally oscillates fails
 * a test instead of hanging a worker.
 */
function collapseArtefacts(html: string): string {
  const imageStrong = new RegExp(`<strong\\b[^>]*>(${IMAGE_ONLY})</strong>`, 'gi');
  let current = html;

  for (let pass = 0; pass < 12; pass += 1) {
    const before = current;

    current = current
      // A run of two or more is somebody pressing Return. One `br` survives:
      // inside a paragraph of address lines it is the line break it looks like.
      .replace(new RegExp(`(?:${BR}\\s*){2,}`, 'gi'), '<br />')
      // At the start or end of a block, even a single one is spacing.
      .replace(new RegExp(`(<(?:${BLOCK_EDGE})\\b[^>]*>)\\s*(?:${BR}\\s*)+`, 'gi'), '$1')
      .replace(new RegExp(`(?:\\s*${BR})+\\s*(</(?:${BLOCK_EDGE})>)`, 'gi'), '$1')
      // Between two blocks, or before the first and after the last.
      .replace(new RegExp(`(</(?:${BLOCK_EDGE})>)\\s*(?:${BR}\\s*)+`, 'gi'), '$1')
      .replace(new RegExp(`(?:\\s*${BR})+\\s*(<(?:${BLOCK_OPEN})\\b[^>]*>)`, 'gi'), '$1')
      .replace(new RegExp(`^\\s*(?:${BR}\\s*)+`, 'i'), '')
      .replace(new RegExp(`(?:\\s*${BR})+\\s*$`, 'i'), '')
      // Freshdesk wraps a screenshot in whatever emphasis was active when it
      // was inserted. Bold has no meaning applied to an image.
      .replace(imageStrong, (match, inner: string) => (/<img\b/i.test(inner) ? inner : match))
      // Now anything left holding nothing.
      .replace(new RegExp(`<(${EMPTIABLE})\\b[^>]*>(?:\\s|${BR})*</\\1>`, 'gi'), '')
      // Two lists of the same kind with nothing between them are one list that
      // an author interrupted with a blank line. Only a bare start tag is
      // merged: an `<ol start="2">` is deliberately continuing a count across
      // something else, and joining it back on would renumber the procedure.
      .replace(/<\/(ul|ol)>\s*<\1>/gi, '')
      // `<strong>ي</strong><strong>جب</strong>` is one word in two elements,
      // which is what happens when an author bolds a phrase in two goes. Only
      // when they touch, and only for emphasis: two adjacent links are two
      // links, and `</strong> <strong>` has a space that has to survive.
      .replace(/<\/(strong|em)><\1>/gi, '');

    if (current === before) return current;
  }

  return current;
}

/**
 * A heading holding a block, which is Freshdesk's other way of producing
 * something that is not a heading.
 *
 * `<h1><p>Email: Help@shipblu.com</p></h1>` is in the claims procedure twice,
 * one for each contact channel — two bullet points the editor promoted to
 * headings without unwrapping the paragraphs inside them. A heading cannot
 * contain a paragraph, and the giveaway is reliable: if there is a block inside
 * it, whatever the author meant, it was not a heading.
 *
 * Only the start tag is matched, and the close is swept up afterwards by
 * `dropStrayHeadingCloses`. Matching the pair is what does not work: in the
 * Magento article an `<h1>` opens before "After you are done installing" and
 * does not close until the end of the document, four sections and three more
 * headings later. A pattern for the pair either misses that one or, if its
 * content is allowed to contain headings, swallows the ones that follow.
 */
const HEADING_BEFORE_BLOCK = /<h[2-6]\b[^>]*>(?=\s*<(?:p|ul|ol|div|blockquote)\b)/gi;

/**
 * A list of exactly one item that opens with a heading.
 *
 * Not a list — a section. Freshdesk leaves this behind when an author starts a
 * bullet, types a heading into it and then writes the section underneath, and
 * it costs the reader a bullet and an indent in front of a heading. The
 * `(?!…ul|ol)` guard keeps the match inside one list: without it the regex
 * spans from an outer list's `<li>` to an inner list's `</ul>` and takes the
 * nesting apart.
 */
const SOLE_HEADING_ITEM =
  /<(ul|ol)\b[^>]*>\s*<li\b[^>]*>\s*(<h[2-6]\b(?:(?!<\/?(?:ul|ol|li)\b)[\s\S])*)<\/li>\s*<\/\1>/gi;

/** Any heading, with no other heading inside it. */
const HEADING = /<h([2-6])\b[^>]*>(?:(?!<\/?h[2-6]\b)[\s\S])*<\/h\1>/gi;

/**
 * A screenshot Freshdesk left inside a heading.
 *
 * `<h2><img />Daily activity updates</h2>` is in the Arabic dashboard article:
 * the image ends the section above and the words open the one below, and the
 * editor put both in the heading. The image comes out in front, where
 * `wrapLooseContent` gives it a paragraph.
 */
const IMAGE_IN_HEADING = /(<h[2-6]\b[^>]*>)((?:\s|<img\b[^>]*\/?>)*<img\b[^>]*\/?>)/gi;

/**
 * The list element an offset sits inside, or undefined at the top level.
 *
 * A backward scan rather than a regex, because "which list am I in" is a
 * question about balance and a regex cannot count. It is what decides whether a
 * split emits `</ul>…<ul>` or `</ol>…<ol>`, and getting that wrong would
 * renumber a procedure.
 */
function enclosingList(html: string, offset: number): string | undefined {
  const stack: string[] = [];
  for (const match of html.slice(0, offset).matchAll(/<(\/?)(ul|ol)\b[^>]*>/gi)) {
    if (match[1]) stack.pop();
    else stack.push(match[2]!.toLowerCase());
  }
  return stack[stack.length - 1];
}

/**
 * Closing heading tags with nothing open to close.
 *
 * Left behind by `HEADING_BEFORE_BLOCK`, and present in the imported HTML on
 * its own account. This is also what a browser does with them: the parser
 * ignores an end tag for an element that is not open, and pops an open heading
 * when another heading starts — so an article carrying these already renders as
 * if they were not there, and removing them makes the stored markup say what
 * the page has always shown.
 */
function dropStrayHeadingCloses(html: string): string {
  let open: string | undefined;

  return html.replace(/<(\/?)h([2-6])\b[^>]*>/gi, (tag, close: string, level: string) => {
    if (!close) {
      // A heading start tag closes an open heading rather than nesting in it.
      const closeOuter = open ? `</h${open}>` : '';
      open = level;
      return `${closeOuter}${tag}`;
    }
    if (!open) return '';
    open = undefined;
    return tag;
  });
}

/**
 * Where the list item containing `offset` ends.
 *
 * Forward scan with a depth counter for the same reason `enclosingList` scans
 * backwards: the item may hold a nested list, and the first `</li>` after a
 * heading is often that list's, not the item's. A tempered regex cannot tell
 * the two apart — it stops at the nested `<li>` and matches nothing.
 */
function itemEnd(html: string, offset: number): { start: number; after: number } | undefined {
  let depth = 0;
  for (const match of html.slice(offset).matchAll(/<(\/?)li\b[^>]*>/gi)) {
    if (!match[1]) depth += 1;
    else if (depth === 0) {
      return { start: offset + match.index, after: offset + match.index + match[0].length };
    } else depth -= 1;
  }
  return undefined;
}

/**
 * Puts a section heading between the lists it divides, rather than inside one.
 *
 * The single-delivery-order guide is the clearest case: it is one long `<ul>` of
 * steps, and the headings that divide it into "Order", "Customer Details" and
 * "Packages" each sit inside the step before, because that is where the cursor
 * was when the author pressed Return and typed one. Freshdesk's editor never
 * left the list, so what should be three sections is one long list with three
 * bullets that happen to be headings — and a heading is not a step.
 *
 * So the item closes, the list closes, the heading stands on its own, and
 * whatever followed the heading inside that item — the section's own prose,
 * which is why this cannot simply lift the heading out — follows it at the same
 * level. The remaining items reopen a list of the same kind, `ol` for `ol`, so
 * a split procedure keeps its numbering.
 *
 * Rewritten back to front, because each edit changes every offset after it. A
 * list or item left empty by the split is removed by `collapseArtefacts`, which
 * is why that runs again afterwards.
 */
function splitListsAtHeadings(html: string): string {
  // Once per level of nesting: a heading inside an item of an inner list comes
  // out of that list, and is then a heading inside an item of the outer one.
  let out = html;
  for (let level = 0; level < 8; level += 1) {
    const lifted = liftHeadingsOnce(out);
    if (lifted === out) return out;
    out = lifted;
  }
  return out;
}

function liftHeadingsOnce(html: string): string {
  let out = html;

  for (const match of [...html.matchAll(HEADING)].reverse()) {
    const at = match.index;
    const list = enclosingList(out, at);
    if (!list) continue;

    const item = itemEnd(out, at + match[0].length);
    if (!item) continue;

    // The item's own `</li>` is consumed, not kept: this half of the split is
    // closed by the `</li>` emitted below, and leaving the original in place is
    // what produced `<ul></li>` — well-formed enough to render, and wrong
    // enough to end a list early in Safari.
    const rest = out.slice(at + match[0].length, item.start);
    out = `${out.slice(0, at)}</li></${list}>${match[0]}${rest}<${list}>${out.slice(item.after)}`;
  }

  return out;
}

/**
 * Blocks whose close ends one flow of content and starts the next. A run of
 * text or inline tags sitting after one of these is a sibling of a block, which
 * is the shape a removed wrapper leaves behind.
 */
const CLOSED_BLOCK = 'p|ul|ol|h2|h3|h4|h5|h6|blockquote|table|pre|figure|dl';

/**
 * Everything that may appear inside a paragraph.
 *
 * Written as a closed list of what *is* inline rather than as "not a block",
 * which is the version of this rule that was wrong: with `li` missing from the
 * block list, a run happily swallowed the `</li><li>` between two list items
 * and wrapped them in a paragraph, moving the list's own structure inside it.
 * Inline is the small, enumerable set — so enumerate it.
 */
const INLINE = 'a|strong|em|b|i|u|s|strike|sub|sup|mark|small|code|br|img|span|iframe';

/**
 * The inline leftovers of an unwrapped `div`, given a paragraph of their own.
 *
 * Removing the wrapper divs is right — they carried a foreign layout — but a
 * `<div>` holding a screenshot or a sentence was still a block, and deleting it
 * leaves that content as a bare sibling of the paragraphs around it. That is
 * not cosmetic: `.kb-article > * + *` is what spaces an article out and
 * `> :is(p, ul, ol, …)` is what caps the measure, and both are child selectors,
 * so a loose `<img>` or a naked sentence gets neither.
 */
function wrapLooseContent(html: string): string {
  const loose = new RegExp(
    // The start of the body, the end of a block, or a rule …
    `(^|</(?:${CLOSED_BLOCK})>|<hr\\s*/?>)` +
      // … followed by text and inline tags only, up to whatever comes next.
      `((?:[^<]|</?(?:${INLINE})\\b[^>]*>)+)`,
    'gi',
  );

  return html.replace(loose, (match, boundary: string, run: string) =>
    run.trim() ? `${boundary}<p>${run.trim()}</p>` : match,
  );
}

/**
 * Brings one article body to the standard above.
 *
 * Idempotent: normalising an already-normalised body returns it unchanged,
 * which is what lets this sit on the save path and in a backfill that may be
 * re-run without either fighting the other.
 */
export function normaliseArticleHtml(html: string): string {
  if (!html) return '';

  let out = html;

  // Before `class` is stripped, because both of these are recognised by it.
  out = out.replace(CALLOUT, '<blockquote>$1</blockquote>');
  out = unwrapImageTables(out);

  // A body heading is one level below the page title, which the article page
  // owns. Sub-headings keep their level; only `h1` is wrong.
  out = out.replace(/<h1\b/gi, '<h2').replace(/<\/h1>/gi, '</h2>');

  // Presentation, direction and link targeting all belong to the page, not to
  // the content. `id` survives — it is an anchor, and something outside this
  // knowledge base may already point at it.
  out = out.replace(/\s+(?:class|style|dir|target)="[^"]*"/gi, '');

  // With their attributes gone these carry nothing at all, so the tags go too.
  // `u` goes with them: every use of it in the corpus was a pseudo-heading, and
  // underline is what a link looks like here.
  out = out.replace(/<\/?(?:span|u)\b[^>]*>/gi, '');
  out = unwrapDivs(out);

  out = collapseArtefacts(out);

  // Structure, once the noise is gone: these read the tags they are deciding
  // about, so they run on markup that has already lost its wrappers and its
  // empty paragraphs rather than having to see past them.
  out = out.replace(HEADING_BEFORE_BLOCK, '');
  out = dropStrayHeadingCloses(out);
  out = out.replace(IMAGE_IN_HEADING, '$2$1');
  out = out.replace(SOLE_HEADING_ITEM, '$2');
  out = splitListsAtHeadings(out);

  out = collapseArtefacts(out);
  out = wrapLooseContent(out);

  return out.trim();
}

/**
 * A cross-reference between two articles, as this knowledge base addresses one.
 *
 * Relative and locale-first, because that is the only form that is right on
 * every host this app answers on: the help centre is served on its own
 * hostname, on the Render service URL under `/help`, and inside the chat
 * widget's iframe.
 */
export function articlePath(locale: string, slug: string): string {
  return `/${locale}/a/${slug}`;
}

/**
 * Freshdesk article URLs, in the two forms the imported bodies actually carry.
 *
 * The customer-facing one is `support.shipblu.com/<locale>/support/solutions/
 * articles/<id>-<title-text>`; the other is the *agent* console at
 * `<account>.freshdesk.com/a/solutions/articles/<id>?lang=<locale>`, which a
 * customer cannot open at all. Both name the article by id, which is what makes
 * them resolvable — the title text after the id changes whenever somebody edits
 * the title, and was never the key.
 */
const LEGACY_ARTICLE_LINK =
  /href="https?:\/\/[^"]*?(?:\/([a-z]{2})\/support)?\/(?:a\/)?solutions\/articles\/(\d+)[^"]*"/gi;

/** `?lang=ar` on an agent-console URL, which is where its locale hides. */
const LANG_PARAM = /[?&]lang=([a-z]{2})/i;

/**
 * Points internal cross-references at this help centre.
 *
 * These links work today only by accident of layering: `proxy.ts` recognises
 * `/solutions/articles/<id>` and `app/help/legacy/route.ts` looks the id up, so
 * a reader who clicks one takes a 301 through a compatibility route that exists
 * for inbound traffic from search engines and old bookmarks. Worse, the URLs are
 * absolute to `support.shipblu.com`, and that hostname still serves Freshdesk —
 * so an article linking to another article currently sends the reader out of
 * this knowledge base and into the old portal.
 *
 * `resolve` is passed in rather than read from the database here so this module
 * stays pure and testable; the job that runs it does the lookup.
 */
export function rewriteLegacyArticleLinks(
  html: string,
  resolve: (
    freshdeskId: string,
    locale: string | undefined,
  ) => { locale: string; slug: string } | undefined,
): string {
  return html.replace(LEGACY_ARTICLE_LINK, (match, pathLocale: string | undefined, id: string) => {
    const locale = pathLocale ?? LANG_PARAM.exec(match)?.[1];
    const target = resolve(id, locale);
    if (!target) return match;
    return `href="${articlePath(target.locale, target.slug)}"`;
  });
}
