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
  return /(freshdesk|freshworks|freshchat|fwcdn|fw-cdn|fwusercontent)/i.test(src);
}

/** Freshworks' own domains, each matched with every subdomain beneath it. */
const FRESHWORKS_DOMAINS = [
  'freshdesk.com',
  'freshworks.com',
  'myfreshworks.com',
  'freshchat.com',
  'fw-cdn.com',
  'fwusercontent.com',
];

/**
 * Freshdesk's attachment bucket, where every image the import brought in
 * lives: `https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/…`.
 */
const FRESHDESK_BUCKET = 'cdn.freshdesk.com';

/**
 * Whether the job may download this `src`: HTTPS, on a Freshworks domain or in
 * Freshdesk's bucket on S3, addressed either way S3 allows.
 *
 * The job runs on the worker with a deadline and a size cap, so this is not a
 * defence against a hostile URL so much as a promise about what it reaches:
 * the addresses in our own articles that Freshworks serves, and nothing a
 * passing match on the audit's pattern happens to name — a host with
 * "freshdesk" somewhere in its path, say. The 214 images measured on
 * 2026-11-07 are all path-style S3 URLs in that bucket.
 */
export function fetchableFreshworksImage(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (FRESHWORKS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return true;
  }

  // S3, path-style (`s3.amazonaws.com/<bucket>/…`, or a regional endpoint)
  // and virtual-hosted (`<bucket>.s3….amazonaws.com/…`).
  if (!host.endsWith('.amazonaws.com')) return false;
  const pathStyle = host === 's3.amazonaws.com' || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host);
  if (pathStyle) return url.pathname.startsWith(`/${FRESHDESK_BUCKET}/`);
  return host.startsWith(`${FRESHDESK_BUCKET}.s3.`) || host.startsWith(`${FRESHDESK_BUCKET}.s3-`);
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
function decodeAttribute(value: string): string {
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
