/**
 * Where an article's pictures load from, read and rewritten in its stored HTML.
 *
 * Pure and import-free: the job that copies Freshdesk's images here
 * (`rehost_kb_images`) uses it on the server, and anything that later needs to
 * draw or check an article's images can use it on either side of the wire.
 *
 * It reads **stored** article HTML only, which is sanitize-html's output run
 * through `normaliseArticleHtml`, and that is what makes a regex pass safe here
 * (the same two invariants `lib/kb/format.ts` states): every attribute is
 * double-quoted, and a `>` or a `"` inside a value arrives escaped, so
 * `<img\b[^>]*>` ends where the tag ends and `src="…"` ends where the value
 * does. Nothing here touches a text node, and a tag is rewritten only in its
 * `src` value, so an article this changes differs from the one it read in
 * those characters and no others.
 */

/**
 * The largest picture an article may hold, copied in or uploaded. Production's
 * largest of the 207 copied is well under a megabyte (28.8 MiB across all of
 * them). For the copy job it bounds what a wrong URL can cost the worker; for
 * an upload it is the sentence an editor meets before anything is sent, and
 * well under the 26 MB a server action's body may carry (`next.config.ts`).
 */
export const KB_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The types an article may show, as read from the bytes, with the extension
 * the stored key takes.
 *
 * Raster images a browser draws everywhere. No SVG, which is a document that
 * runs its author's script; no HEIC, which only Safari draws; and nothing a
 * remote server or a browser merely *says* is an image, since what is stored
 * here is served back with this type. Here rather than beside the check in
 * `./images.ts` so the editor can offer the same list before it uploads.
 */
export const KB_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** What an editor is told about a file that is not a picture an article may show. */
export const NOT_A_PICTURE = 'Only a PNG, JPEG, GIF or WebP picture can go in an article.';

/**
 * Why a file of `size` bytes cannot be an article's picture, or null.
 *
 * One copy for the editor, which asks before it uploads, and the server, which
 * asks again, so the limit an editor reads is the one enforced. "Over", never a
 * rounded figure: a file one byte past the limit read as "10.0 MB" beside a
 * limit of 10 MB.
 */
export function pictureSizeRefusal(size: number): string | null {
  if (size === 0) return 'That file is empty. Choose a picture to upload.';
  if (size > KB_IMAGE_MAX_BYTES) {
    return `That picture is over ${KB_IMAGE_MAX_BYTES / (1024 * 1024)} MB, the most a picture can be.`;
  }
  return null;
}

/**
 * Whether the browser's own label rules a file out before it is sent.
 *
 * Only a label that plainly names something else: an empty one, or an image
 * type spelled unusually (`image/jpg`), goes to the server, which reads the
 * bytes and is the only judge. This saves a round trip; it decides nothing.
 */
export function labelRulesOut(type: string): boolean {
  return type !== '' && !type.startsWith('image/');
}

/**
 * The markup the editor puts in for a picture it uploaded: a paragraph of its
 * own, so the formatting standard keeps it a block, with `alt` left for the
 * author to fill.
 */
export function pictureParagraph(src: string): string {
  return `<p><img src="${encodeAttribute(src)}" alt="" /></p>`;
}

/** An opening or closing tag in an author's draft: `<p>`, `</a>`, `<br />`. */
const DRAFT_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;

/** Tags that never take a closing tag, so they open no element to stay inside. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/**
 * The tags an article keeps inside a paragraph. At the top level of a body,
 * text and these together are one run, which `normaliseArticleHtml` wraps in
 * one paragraph on every write (`wrapLooseContent` in `./format.ts`), so the
 * editor reads a draft's runs by the same list (`blockBoundaryAfter`). Every
 * other tag is a block.
 */
export const INLINE_TAGS = [
  'a',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'strike',
  'sub',
  'sup',
  'mark',
  'small',
  'code',
  'br',
  'img',
  'span',
  'iframe',
] as const;

const INLINE = new Set<string>(INLINE_TAGS);

/**
 * Where a block can go in an author's HTML draft at or after `caret`: the caret
 * itself when it is between top-level blocks, otherwise the end of the
 * top-level block, or of the run of loose text, it is in.
 *
 * The draft is the editor's source text, not stored HTML, so this reads tags as
 * an author types them. A caret in the middle of a paragraph (`<p>Open the|
 * settings</p>`) or inside a tag (`<a hr|ef=…>`) would otherwise split it: the
 * browser closes the paragraph early, the rest becomes loose text with a stray
 * `</p>` after it, and that is what Save stores. A draft whose tags never close
 * again gets the block at its end.
 *
 * Text outside any block is read the way Save reads it: together with the
 * inline elements in it (`INLINE_TAGS`), one run that becomes one paragraph. So
 * a link in a loose sentence is part of the sentence, not a block of its own
 * to put a picture after.
 */
export function blockBoundaryAfter(html: string, caret: number): number {
  let depth = 0;
  // Whether the top-level element open now is a block. A top-level inline
  // element is part of the run around it.
  let inBlock = false;
  // Where the run the walk is in began: the start of the draft, or the end of
  // the last top-level block.
  let runStart = 0;

  for (const match of html.matchAll(DRAFT_TAG)) {
    const start = match.index;
    const end = start + match[0].length;
    const name = (match[2] ?? '').toLowerCase();
    const closing = match[1] === '/';
    const opens = !closing && match[3] !== '/' && !VOID_TAGS.has(name);

    if (depth === 0) {
      if (INLINE.has(name)) {
        if (opens) {
          depth = 1;
          inBlock = false;
        }
        continue;
      }
      // A block starts here, so the run before it ends.
      if (caret <= start) return withinRun(html, runStart, caret, start);
      if (opens) {
        depth = 1;
        inBlock = true;
        continue;
      }
      // A block with nothing inside it: `<hr>`, `<p/>`, a stray `</p>`.
      if (end >= caret) return end;
      runStart = end;
      continue;
    }

    if (closing) depth -= 1;
    else if (opens) depth += 1;
    if (depth === 0 && inBlock) {
      if (end >= caret) return end;
      runStart = end;
    }
  }

  return depth === 0
    ? withinRun(html, runStart, Math.min(caret, html.length), html.length)
    : html.length;
}

/**
 * A caret in the run from `from` to `to`: the caret itself when only
 * whitespace lies behind it back to the run's start, or ahead of it to the
 * run's end, since it already sits between blocks there; otherwise the end of
 * the run's text.
 *
 * A run is one paragraph once saved, line breaks and all, so a block put in the
 * middle of it splits a sentence. A body typed with no tags at all is one run.
 */
function withinRun(html: string, from: number, caret: number, to: number): number {
  const ahead = html.slice(caret, to);
  if (html.slice(from, caret).trim() === '' || ahead.trim() === '') return caret;
  return caret + ahead.trimEnd().length;
}

/**
 * `text` with `block` put at `at`, on lines of its own, and where the caret
 * goes after it.
 */
export function insertBlock(
  text: string,
  at: number,
  block: string,
): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  const trail = after && !after.startsWith('\n') ? '\n' : '';
  const inserted = `${lead}${block}${trail}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/** The route that serves a picture we hold (`app/api/kb/images/[id]/route.ts`). */
const KB_IMAGE_ROUTE = '/api/kb/images/';

/**
 * The `src` an article stores for one of our images.
 *
 * A path, not a URL: an article is drawn on the help centre's own host, on the
 * Render host, inside the widget's iframe and in the console, all of them this
 * app, so a relative path loads on every one — as `articlePath` makes links.
 * An absolute URL would name one host and break the day the domain moves.
 */
export function kbImageSrc(id: string): string {
  return `${KB_IMAGE_ROUTE}${id}`;
}

const KB_IMAGE_SRC =
  /^\/api\/kb\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The id a `src` names when it is one of ours, or null. */
export function kbImageIdOf(src: string): string | null {
  return KB_IMAGE_SRC.exec(src)?.[1]?.toLowerCase() ?? null;
}

/**
 * Whether a `src` is a Freshworks address, by the pattern the disconnection
 * audit counts with (`plans/freshdesk-disconnection.md`, "Re-running this
 * audit").
 *
 * Deliberately the audit's own pattern rather than a tidier host check: PR 1
 * is verified by that query's two `images` rows answering 0, so the job has to
 * see at least everything the query sees. What it may *download* is the
 * narrower question `fetchableFreshworksImage` answers, and anything this
 * matches that the other refuses is reported by name rather than skipped in
 * silence.
 */
export function isFreshworksImage(src: string): boolean {
  return /(freshdesk|freshworks|freshchat|freshservice|fwcdn|fw-cdn|fwusercontent)/i.test(src);
}

/**
 * Freshworks' own domains, each matched with every subdomain beneath it.
 *
 * `isFreshworksImage` must match every one: a domain here that the pattern
 * misses is a picture Save refuses and the copy job never selects, so nothing
 * moves it. `image-src.test.ts` holds the two together.
 */
export const FRESHWORKS_DOMAINS = [
  'freshdesk.com',
  'freshworks.com',
  'myfreshworks.com',
  'freshchat.com',
  'freshservice.com',
  'fw-cdn.com',
  'fwcdn.com',
  'fwusercontent.com',
];

/**
 * Freshdesk's attachment bucket, where every image the import brought in
 * lives: `https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/…`.
 */
const FRESHDESK_BUCKET = 'cdn.freshdesk.com';

/** That bucket addressed virtual-hosted style: `cdn.freshdesk.com.s3[.region].amazonaws.com`. */
const FRESHDESK_VIRTUAL_HOST = /^cdn\.freshdesk\.com\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;

/**
 * Whether the job may download this `src`: HTTPS, with no credentials in it,
 * and on Freshworks' own hosts (`onFreshworks`).
 *
 * The job runs on the worker with a deadline and a size cap, so this is not a
 * defence against a hostile URL so much as a promise about what it reaches:
 * the addresses in our own articles that Freshworks serves, and nothing a
 * passing match on the audit's pattern happens to name — a host with
 * "freshdesk" somewhere in its path, say. The 214 images measured on
 * 2026-11-07 are all path-style S3 URLs in that bucket.
 *
 * The host list is the refusal's too, so it holds every Freshworks domain an
 * article might name, `freshservice.com` and `fwcdn.com` among them, and the
 * job may download from each. That is on purpose: a picture any of Freshworks'
 * hosts serves goes with Freshdesk, and the job is what keeps it. No stored
 * image is on either today.
 */
export function fetchableFreshworksImage(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return onFreshworks(url);
}

/**
 * Whether an address is served by Freshworks: on one of its domains, or in
 * Freshdesk's bucket on S3, addressed either way S3 allows. The scheme is not
 * asked — an `http://` picture breaks with Freshdesk all the same.
 *
 * One answer for the two questions that need it, so they cannot drift apart:
 * what the copy job may download (`fetchableFreshworksImage`), and what an
 * article may not gain once the copies exist (`lib/kb/freshdesk-refs.ts`).
 */
export function onFreshworks(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (FRESHWORKS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return true;
  }

  // S3, path-style (`s3.amazonaws.com/<bucket>/…`, or a regional endpoint)
  // and virtual-hosted (`<bucket>.s3….amazonaws.com/…`).
  if (!host.endsWith('.amazonaws.com')) return false;
  const pathStyle = host === 's3.amazonaws.com' || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host);
  if (pathStyle) return url.pathname.startsWith(`/${FRESHDESK_BUCKET}/`);
  // The whole host, never a prefix of it: a bucket name may itself contain
  // dots, so `cdn.freshdesk.com.s3.evil.s3.amazonaws.com` — somebody's bucket
  // called `cdn.freshdesk.com.s3.evil` — starts the way Freshdesk's does. The
  // region label between `s3` and `amazonaws.com`, when there is one, is a
  // single label with no dot in it.
  return FRESHDESK_VIRTUAL_HOST.test(host);
}

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /(\ssrc=")([^"]*)(")/i;

/** Every `<img>`'s `src` in stored article HTML, decoded, in document order. */
export function imageSources(html: string): string[] {
  const sources: string[] = [];
  for (const tag of html.match(IMG_TAG) ?? []) {
    const value = SRC_ATTR.exec(tag)?.[2];
    if (value !== undefined) sources.push(decodeAttribute(value));
  }
  return sources;
}

/**
 * Rewrites each `<img>`'s `src` that `replace` answers for, and leaves every
 * other character as it was.
 *
 * `replace` is handed the decoded address and answers the decoded address to
 * put there, or `undefined` to leave that one alone, so a caller never deals in
 * entities. The answer is escaped as sanitize-html escapes an attribute, so a
 * rewritten body is one the write path would store unchanged
 * (`image-src.test.ts` holds it to that).
 */
export function rewriteImageSources(
  html: string,
  replace: (src: string) => string | undefined,
): { html: string; replaced: number } {
  let replaced = 0;
  const rewritten = html.replace(IMG_TAG, (tag) =>
    tag.replace(SRC_ATTR, (whole, open: string, value: string, close: string) => {
      const next = replace(decodeAttribute(value));
      if (next === undefined) return whole;
      const encoded = encodeAttribute(next);
      if (encoded === value) return whole;
      replaced += 1;
      return `${open}${encoded}${close}`;
    }),
  );
  return { html: rewritten, replaced };
}

/**
 * The entities sanitize-html writes into an attribute value, and the numeric
 * forms a stored body could carry from before it was sanitised the same way.
 */
export function decodeAttribute(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|#x27|#34|#x22);/gi, (_, name: string) => {
    switch (name.toLowerCase()) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case '#39':
      case '#x27':
        return "'";
      default:
        return '"';
    }
  });
}

/** As sanitize-html escapes a double-quoted attribute value. */
function encodeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
