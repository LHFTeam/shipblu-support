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
 * part of the portal nothing here replaces. One on Freshdesk's own hosts breaks
 * the day Freshdesk is disconnected. One on the portal's hostname stopped
 * reaching Freshdesk when that name moved here on 2026-11-11, and gets what
 * this app answers there: an article or folder only through `app/help/legacy`,
 * a page of the portal at most a stand-in (`./freshdesk-portal.ts`), the rest a
 * 404 or the console's sign-in. Each is refused only when the write would *add*
 * it. One the stored row already carries is left alone: refusing it would make
 * the article unsaveable until somebody found and removed it, whatever the save
 * was for, and leaving it costs nothing the article does not already cost.
 * `rehost_kb_images` and the audit in `plans/freshdesk-disconnection.md` are
 * what find those.
 */

/**
 * Which of Freshdesk's addresses this is: `freshworks` for one on Freshworks'
 * own hosts, its bucket or a mailbox, which breaks when the account closes;
 * `portal` for a portal path on the portal's hostname or with no host, which
 * stopped reaching Freshdesk when that hostname moved here.
 */
type FreshdeskHome = 'freshworks' | 'portal';

export type FreshdeskReference = {
  kind: 'link' | 'image';
  address: string;
  home: FreshdeskHome;
};

/**
 * The Freshdesk portal's own hostname. It served Freshdesk until 2026-11-11
 * and has answered from this app since, so `/<locale>/a/<slug>` there is a
 * good link — the host alone is never refused, only Freshdesk's paths on it.
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
 * (measured 2026-11-09); they are here because an old portal address pasted
 * in can carry them, and since the domain moved on 2026-11-11 each answers
 * a 404 or the console's sign-in page there.
 */
const PORTAL_PATH =
  /\/solutions\/(?:articles|folders|categories)(?:\/|$)|\/support\/(?:solutions|home|tickets|login|search|signup|profile|discussions|topics)(?:\/|$)|\/helpdesk\/attachments(?:\/|$)/i;

/** A Freshdesk article, by id, in any of the shapes above. */
const ARTICLE_ID = /\/solutions\/articles\/(\d+)/i;

const A_TAG = /<a\b[^>]*>/gi;
const HREF_ATTR = /\shref="([^"]*)"/i;

/**
 * Whether an address is Freshdesk's: one on Freshworks' hosts or in Freshdesk's
 * bucket (`onFreshworks`), a `mailto:` one of its mailboxes, or a portal path
 * on the portal's host or with no host at all. All but a portal path break
 * with Freshdesk; one on the portal's host stopped reaching it when that host
 * moved here (the header above).
 *
 * Narrower than the audit's pattern, which matches its words anywhere in an
 * address. A blog post about leaving Freshdesk, or another company's own
 * Freshdesk portal on its own domain, does not break when ours closes, and an
 * editor refused a link to one would have nothing to fix.
 */
export function isFreshdeskAddress(address: string): boolean {
  return freshdeskHome(address) !== null;
}

/** `isFreshdeskAddress`, saying which kind of address it found. */
function freshdeskHome(address: string): FreshdeskHome | null {
  let url: URL;
  try {
    url = new URL(address.trim(), RELATIVE_BASE);
  } catch {
    return null;
  }

  if (url.protocol === 'mailto:') {
    // `mailto:` may name several addresses, comma-separated, and escaped.
    let recipients = url.pathname;
    try {
      recipients = decodeURIComponent(recipients);
    } catch {
      // A malformed escape: read the address as written.
    }
    const mailbox = recipients.split(',').some((recipient) => {
      try {
        return onFreshworks(new URL(`https://${recipient.split('@').at(-1)?.trim() ?? ''}`));
      } catch {
        return false;
      }
    });
    return mailbox ? 'freshworks' : null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (onFreshworks(url)) return 'freshworks';

  const host = url.hostname.toLowerCase();
  const portal = url.href.startsWith(RELATIVE_BASE) || host === PORTAL_HOST;
  return portal && PORTAL_PATH.test(url.pathname) ? 'portal' : null;
}

/** Every Freshdesk link and picture in stored article HTML, decoded, links first. */
export function freshdeskReferences(html: string): FreshdeskReference[] {
  const references: FreshdeskReference[] = [];

  for (const tag of html.match(A_TAG) ?? []) {
    const value = HREF_ATTR.exec(tag)?.[1];
    if (value === undefined) continue;
    const address = decodeAttribute(value);
    const home = freshdeskHome(address);
    if (home) references.push({ kind: 'link', address, home });
  }
  for (const address of imageSources(html)) {
    const home = freshdeskHome(address);
    if (home) references.push({ kind: 'image', address, home });
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
    ? `The article shows ${described(added)}. Remove it, or add the picture again with Insert picture, then save.`
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
 *
 * Anything else is said by where it lives (`FreshdeskHome`). One on Freshworks'
 * own hosts still works and stops when the account closes, so the editor is
 * told that. One on the portal's hostname has not reached Freshdesk since that
 * hostname moved here on 2026-11-11: a picture there answers nothing, and a
 * page answers a stand-in here at best (`./freshdesk-portal.ts`). Telling the
 * editor it goes away later would say it works now.
 */
function described(reference: FreshdeskReference): string {
  const { address } = reference;
  if (reference.kind === 'image') {
    return reference.home === 'portal'
      ? `a picture from Freshdesk's old portal, which no longer loads (${address})`
      : `a picture from Freshdesk, which stops loading once Freshdesk is disconnected (${address})`;
  }
  const id = ARTICLE_ID.exec(address)?.[1];
  if (id) {
    return `a link to Freshdesk article ${id}, which has no published article here (${address})`;
  }
  return reference.home === 'portal'
    ? `a link to Freshdesk's old portal, which no longer exists (${address})`
    : `a link to Freshdesk, which goes away once Freshdesk is disconnected (${address})`;
}
