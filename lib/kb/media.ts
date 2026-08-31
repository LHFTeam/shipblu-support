import { createHash } from 'node:crypto';

/**
 * Article media that lives on somebody else's CDN, and the rules for bringing
 * it onto ours.
 *
 * The Freshdesk import copied the articles and left the pictures behind: every
 * screenshot in the knowledge base still loads from
 * `s3.amazonaws.com/cdn.freshdesk.com`, which is a dependency on a vendor
 * account we are in the middle of leaving. `worker/handlers/mirror-kb-media.ts`
 * copies the bytes; this file holds the parts both that job and the importer
 * need, so a re-import cannot quietly restore the URLs the mirror just replaced.
 */

/**
 * Hosts a mirror job is allowed to fetch from.
 *
 * An allowlist rather than "any URL in the article", and the difference is not
 * cosmetic: the job takes a URL out of stored HTML and fetches it with the
 * worker's own network position, which is inside the private network. An open
 * version of this is a request forgery primitive that an article author — or
 * whoever wrote the HTML that got imported years ago — chooses the target of.
 * So the check is on the parsed URL's host, never on a substring of the string.
 *
 * Freshdesk serves attachments from a bucket path on `s3.amazonaws.com` rather
 * than a branded host, which is why the path prefix is part of the rule: the
 * host alone would admit every bucket on S3.
 */
const MIRRORABLE: { host: string; pathPrefix?: string }[] = [
  { host: 's3.amazonaws.com', pathPrefix: '/cdn.freshdesk.com/' },
  { host: 's3.eu-central-1.amazonaws.com', pathPrefix: '/cdn.freshdesk.com/' },
  { host: 'cdn.freshdesk.com' },
  { host: 'attachment.freshdesk.com' },
];

export function isMirrorableMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;

  return MIRRORABLE.some(
    (entry) =>
      entry.host === url.hostname &&
      (!entry.pathPrefix || url.pathname.startsWith(entry.pathPrefix)),
  );
}

/**
 * Image types an article picture is allowed to be stored as.
 *
 * The same reasoning as `isStorableAvatarType`, and SVG is excluded for the
 * same reason: a browser treats it as an image and a script host both, and
 * these are served back under our own origin to customers.
 */
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function isStorableMediaType(contentType: string): boolean {
  return contentType.split(';')[0]!.trim().toLowerCase() in IMAGE_TYPES;
}

/**
 * The object key, derived entirely from a hash of the source URL.
 *
 * Content-addressed on purpose. The Arabic and English versions of an article
 * reference the same remote file, and so do the two halves of every translation
 * pair that shares a screenshot — keying on the URL means both `kb_media` rows
 * address one object rather than two identical copies, and a re-run overwrites
 * in place instead of accumulating.
 *
 * A hash rather than any part of the URL itself, because the last path segment
 * of a Freshdesk attachment URL is a filename somebody else chose, and a path
 * segment taken from a URL is a path segment taken from an attacker.
 */
export function buildKbMediaPath(sourceUrl: string, contentType: string): string {
  const digest = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 32);
  const extension = IMAGE_TYPES[contentType.split(';')[0]!.trim().toLowerCase()] ?? 'bin';
  return `kb/media/${digest}.${extension}`;
}

/** Where a stored image is served from. Relative, so it works on either host. */
export function kbMediaPath(mediaId: string): string {
  return `/api/kb/media/${mediaId}`;
}

/**
 * Every `src` in an article's HTML that this job would copy.
 *
 * A regex over the stored HTML rather than a parse. The input is already
 * sanitised — `sanitiseArticleHtml` ran on the way in — so what is being read
 * here is our own normalised output, and every URL it yields is checked against
 * the allowlist above before anything is fetched. Deduplicated, because the
 * same screenshot appears more than once in several articles.
 */
export function mirrorableSources(html: string): string[] {
  const found = new Set<string>();

  for (const match of html.matchAll(/<img\b[^>]*?\ssrc="([^"]+)"/gi)) {
    const src = decodeHtmlEntities(match[1]!);
    if (isMirrorableMediaUrl(src)) found.add(src);
  }

  return [...found];
}

/**
 * Point an article's images at their stored copies.
 *
 * Takes a map rather than doing its own lookups so the importer and the mirror
 * job cannot disagree about what a rewritten article looks like — the same rule
 * that keeps `refreshRequesterProfile` and its job on one function. A source URL
 * with no entry in the map is left exactly as it was: a partially mirrored
 * article still renders, with the images that have been copied served from us
 * and the rest still loading from where they always did.
 *
 * The result is HTML we assembled from HTML we already sanitised, and the
 * callers sanitise it again before storing it. That second pass is not
 * redundant: it is what keeps "sanitise on write" true of the row rather than
 * true of the row's history.
 */
export function rewriteArticleMedia(html: string, storedBySource: Map<string, string>): string {
  if (storedBySource.size === 0) return html;

  return html.replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/gi, (whole, prefix, src: string, suffix) => {
    const replacement = storedBySource.get(decodeHtmlEntities(src));
    return replacement ? `${prefix}${replacement}${suffix}` : whole;
  });
}

/**
 * The entities a sanitiser leaves in an attribute value.
 *
 * `sanitize-html` re-encodes `&` as `&amp;` when it writes an attribute back
 * out, and Freshdesk's URLs carry query strings — so the `src` in the stored
 * HTML is not byte-identical to the URL that has to be fetched, and a map keyed
 * on the raw attribute would miss every one of them.
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
