/**
 * What the article page reads off an article's body: its sections, for the "On
 * this page" rail, and how long it takes to read.
 *
 * This runs on the stored body, which is sanitize-html's own output wrapped in
 * `normaliseArticleHtml` (`lib/kb/format.ts`) — so the same two invariants that
 * make a regex pass over markup safe there hold here. It never touches a text
 * node, and the only thing it ever writes into the markup is an `id` on an `<h2>`
 * that has none, with a value of our own making. That is not sanitising on read:
 * nothing is removed or trusted that was not already stored, and a body with no
 * `<h2>` comes back byte for byte.
 */

export type ArticleSection = { id: string; label: string };

export type ArticleOutline = {
  /** The body, every `<h2>` carrying an id the rail can link to. */
  html: string;
  sections: ArticleSection[];
};

/**
 * An `<h2>` and everything up to its close. Headings do not nest, and the
 * sanitiser closes every element it keeps, so the lazy match ends at the
 * heading's own `</h2>`.
 */
const H2 = /<h2(\s[^>]*)?>([\s\S]*?)<\/h2\s*>/gi;
const ID_SOURCE = String.raw`\sid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`;
const ID_ATTR = new RegExp(ID_SOURCE, 'i');
const ID_ATTRS = new RegExp(ID_SOURCE, 'gi');

export function articleOutline(html: string): ArticleOutline {
  const sections: ArticleSection[] = [];
  const listed = new Set<string>();

  // Every id anywhere in the body is reserved before any is handed out, so a
  // heading numbered here can never collide with an anchor further down that
  // the editor wrote by hand.
  const reserved = new Set<string>();
  for (const match of html.matchAll(ID_ATTRS)) reserved.add(idValue(match));

  let counter = 0;
  const withIds = html.replace(H2, (whole, attrs: string | undefined, inner: string) => {
    const label = textOf(inner);
    if (!label) return whole;

    const existing = attrs ? ID_ATTR.exec(attrs) : null;
    const kept = existing ? idValue(existing) : '';

    // An id the editor or the Freshdesk import already gave the heading stays:
    // a link elsewhere in the article may point at it. A duplicate is left alone
    // in the markup but not offered twice, since the second link would land on
    // the first heading.
    if (kept) {
      if (listed.has(kept)) return whole;
      listed.add(kept);
      sections.push({ id: kept, label });
      return whole;
    }

    let id: string;
    do {
      counter += 1;
      id = `section-${counter}`;
    } while (reserved.has(id) || listed.has(id));
    listed.add(id);
    sections.push({ id, label });
    return `<h2 id="${id}"${attrs ?? ''}>${inner}</h2>`;
  });

  return { html: withIds, sections };
}

function idValue(match: RegExpMatchArray | RegExpExecArray): string {
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

/**
 * Minutes to read, rounded and never zero.
 *
 * Two hundred words a minute, in either language. Arabic reads somewhat slower
 * per word and its words are fewer per sentence, and the two roughly cancel at
 * the length of a help article; a figure that is honest to the nearest minute is
 * all the meta line promises. Screenshots, which are most of what an imported
 * procedure contains, are counted as the ten seconds a reader spends on each.
 */
export function readingMinutes(html: string): number {
  const words = textOf(html).split(/\s+/u).filter(Boolean).length;
  const images = (html.match(/<img\b/gi) ?? []).length;
  return Math.max(1, Math.round(words / 200 + images / 6));
}

/** The visible text of a fragment: tags gone, entities read, spaces collapsed. */
function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/gu, ' ')
    .trim();
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED[body.toLowerCase()] ?? entity;
  });
}
