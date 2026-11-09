import { decodeAttribute, imageSources, onFreshworks } from './image-src';

/**
 * The Freshdesk addresses an article body links to or shows, and the sentence
 * a write that would add one is refused with.
 *
 * Pure, and over **stored** article HTML only — sanitize-html's output run
 * through `normaliseArticleHtml` — for the reason `./image-src.ts` gives: every
 * attribute is double-quoted and a `<` in a text node arrives escaped, so
 * `<a\b[^>]*>` is a tag and `href="…"` ends where the value does.
 *
 * Asked by the console's Save and Restore once the body has been pointed here
 * (`./off-freshdesk.ts`), so what it finds is what has no home here: a picture
 * nobody copied, a link to an article with no published copy here, a link to a
 * part of the portal nothing here replaces. Each of those breaks the day
 * Freshdesk is disconnected, and each is refused only when the write would
 * *add* it. One the stored row already carries is left alone: refusing it
 * would make the article unsaveable until somebody found and removed it,
 * whatever the save was for, and leaving it costs nothing the article does not
 * already cost. `rehost_kb_images` and the audit in
 * `plans/freshdesk-disconnection.md` are what find those.
 */

export type FreshdeskReference = { kind: 'link' | 'image'; address: string };

/**
 * The Freshdesk portal's own hostname. It serves Freshdesk until the domain
 * moves, and is ours afterwards, when `/<locale>/a/<slug>` there is a good
 * link — so the host alone is never refused, only Freshdesk's paths on it.
 */
const PORTAL_HOST = 'support.shipblu.com';

/** What a relative address resolves against, so it can be read as a URL. */
const RELATIVE_BASE = 'https://relative.invalid/';

/**
 * A Freshdesk portal path: the knowledge base's articles, folders and
 * categories, the portal's home, tickets, sign-in, search and forums, with or
 * without a locale first, and the attachments it serves from its own host
 * (`/helpdesk/attachments/<id>`, which names no Freshworks domain at all). The
 * agent console's `/a/solutions/articles/<id>` matches too, though its host
 * already does. None of the forum or attachment shapes is stored today
 * (measured 2026-11-09); they are here because a paste from the portal can
 * carry them, and each breaks the day the domain moves.
 */
const PORTAL_PATH =
  /\/solutions\/(?:articles|folders|categories)(?:\/|$)|\/support\/(?:solutions|home|tickets|login|search|signup|profile|discussions|topics)(?:\/|$)|\/helpdesk\/attachments(?:\/|$)/i;

/** A Freshdesk article, by id, in any of the shapes above. */
const ARTICLE_ID = /\/solutions\/articles\/(\d+)/i;

const A_TAG = /<a\b[^>]*>/gi;
const HREF_ATTR = /\shref="([^"]*)"/i;

/**
 * Whether an address breaks with Freshdesk: one on Freshworks' hosts or in
 * Freshdesk's bucket (`onFreshworks`), a `mailto:` one of its mailboxes, or a
 * portal path on the portal's host or with no host at all.
 *
 * Narrower than the audit's pattern, which matches its words anywhere in an
 * address. A blog post about leaving Freshdesk, or another company's own
 * Freshdesk portal on its own domain, does not break when ours closes, and an
 * editor refused a link to one would have nothing to fix.
 */
export function isFreshdeskAddress(address: string): boolean {
  let url: URL;
  try {
    url = new URL(address.trim(), RELATIVE_BASE);
  } catch {
    return false;
  }

  if (url.protocol === 'mailto:') {
    // `mailto:` may name several addresses, comma-separated, and escaped.
    let recipients = url.pathname;
    try {
      recipients = decodeURIComponent(recipients);
    } catch {
      // A malformed escape: read the address as written.
    }
    return recipients.split(',').some((recipient) => {
      try {
        return onFreshworks(new URL(`https://${recipient.split('@').at(-1)?.trim() ?? ''}`));
      } catch {
        return false;
      }
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (onFreshworks(url)) return true;

  const host = url.hostname.toLowerCase();
  const portal = url.href.startsWith(RELATIVE_BASE) || host === PORTAL_HOST;
  return portal && PORTAL_PATH.test(url.pathname);
}

/** Every Freshdesk link and picture in stored article HTML, decoded, links first. */
export function freshdeskReferences(html: string): FreshdeskReference[] {
  const references: FreshdeskReference[] = [];

  for (const tag of html.match(A_TAG) ?? []) {
    const value = HREF_ATTR.exec(tag)?.[1];
    if (value === undefined) continue;
    const address = decodeAttribute(value);
    if (isFreshdeskAddress(address)) references.push({ kind: 'link', address });
  }
  for (const address of imageSources(html)) {
    if (isFreshdeskAddress(address)) references.push({ kind: 'image', address });
  }

  return references;
}

/**
 * Why the console's Save refuses `next`, or null when it may be written.
 *
 * `current` is the stored body, null for a new article: a reference it already
 * carries is not one the save adds.
 */
export function saveRefusal(next: string, current: string | null): string | null {
  const added = addedReference(next, current);
  if (!added) return null;

  return added.kind === 'image'
    ? `The article shows ${described(added)}. Remove the picture, then save.`
    : `The article has ${described(added)}. Point it at an article on this help centre (/<language>/a/<slug>) or remove it, then save.`;
}

/**
 * Why Restore refuses to put `next` back, or null when it may.
 *
 * `current` is the body the restore would replace, so a version holding only
 * what the article already holds can still be restored.
 */
export function restoreRefusal(next: string, current: string): string | null {
  const added = addedReference(next, current);
  if (!added) return null;

  const what = added.kind === 'image' ? `shows ${described(added)}` : `has ${described(added)}`;
  return `That version ${what}, so restoring it would put Freshdesk back on the help centre. Restore another version, or edit the article instead.`;
}

/** The first reference in `next` that `current` does not carry. */
function addedReference(next: string, current: string | null): FreshdeskReference | undefined {
  const kept = new Set((current ? freshdeskReferences(current) : []).map(key));
  return freshdeskReferences(next).find((reference) => !kept.has(key(reference)));
}

function key(reference: FreshdeskReference): string {
  return `${reference.kind} ${reference.address}`;
}

/**
 * The reference, said so that whoever reads it knows which one and why.
 *
 * An article link names the id, because the only way one survives being
 * pointed here is that no published article here came from it: never
 * imported, or imported and since unpublished (`legacyArticleIndex`).
 */
function described(reference: FreshdeskReference): string {
  if (reference.kind === 'image') {
    return `a picture from Freshdesk, which stops loading once Freshdesk is disconnected (${reference.address})`;
  }
  const id = ARTICLE_ID.exec(reference.address)?.[1];
  if (id) {
    return `a link to Freshdesk article ${id}, which has no published article here (${reference.address})`;
  }
  return `a link to Freshdesk, which goes away once Freshdesk is disconnected (${reference.address})`;
}
