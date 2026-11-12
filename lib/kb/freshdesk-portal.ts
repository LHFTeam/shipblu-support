import { DEFAULT_LOCALE, isLocale, type Locale } from './locale';

/**
 * Where Freshdesk's portal pages send their reader, now that
 * `support.shipblu.com` is this app (moved 2026-11-11, about 20:54 UTC).
 *
 * Freshdesk's article and folder URLs are not here: they name a row, so they
 * go to `app/help/legacy/route.ts`, which looks it up (`./legacy-path.ts`).
 * These name a page of the portal itself — its front door, its knowledge-base
 * index, its ticket form, its sign-in — and each has a counterpart here that no
 * lookup is needed to find. So `proxy.ts` answers them itself, ahead of the
 * help-centre host's catch-all and the console's sign-in redirect, which
 * answered them with the help centre's 404 or the console's
 * `/login?next=…` (measured on production, 2026-11-11 and 12). Pure and
 * import-light for the reason `./legacy-path.ts` is: the proxy imports it and
 * stays out of the database.
 *
 * What arrived is the evidence for each rule. Render's request log for
 * `support.shipblu.com` from 2026-11-11 21:04 to 2026-11-12 09:15 UTC, our own
 * curl checks left out: the portal home 22 times (`/ar` and `/en`, phones in
 * Egypt among them), Freshdesk category pages 8, the knowledge-base index 6,
 * Freshdesk's search 6 (one person, in Arabic), the ticket form 5 (Googlebot
 * among them), the sign-in and sign-up 4, and one ticket page, from a
 * Freshdesk notification email opened on an iPhone.
 *
 * **Every answer is a 302, on purpose.** By the rule the legacy route follows
 * (`LegacyAnswer`), the home and the index would earn a 301: each names the page
 * it lands on, and a 301 is what moves a URL's search standing. Two things
 * outweigh that while Freshdesk is still live. A browser keeps a 301 with no
 * expiry, and these are the paths Freshdesk's own `/` redirects through
 * (`/` → `/support/home` → `/ar/support/home`), so were the DNS move rolled
 * back, every browser that had loaded the home here would carry Freshdesk's
 * front door off to `/ar` on Freshdesk: a dead end, or a loop if Freshdesk
 * sends `/ar` back to `/ar/support/home`. And a 301 buys little meanwhile:
 * `/ar` is already the canonical page, in the sitemap and linked from every
 * page, and a search engine comes to treat a lasting 302 as permanent. So the
 * home and the index become 301 once Freshdesk is disconnected and the name
 * cannot go back (`plans/freshdesk-disconnection.md`, PR 7). The rest stay 302
 * for a reason of their own: each lands on a stand-in for a page this help
 * centre does not have yet, and a kept 301 would pin the stand-in after the
 * real one exists. Never a 307 or a 308, which keep the method and the body:
 * a stale Freshdesk sign-in form posted here would re-send the customer's
 * Freshdesk password to wherever it was redirected.
 *
 * **The ticket pages, the sign-in and the sign-up land on the home's contact
 * band** (`/<locale>#contact`, the section the header's Contact link opens), not
 * on the portal, though the portal has a counterpart for each:
 *
 *  - `/<locale>/forms` is this help centre's new-ticket door, but with no form
 *    built — production has none (2026-11-12) — it redirects to `/portal/new`,
 *    which asks for an account: three hops to a sign-in wall. That is why the
 *    help centre's own contact buttons open the chat instead (`AskSupport`).
 *  - `/<locale>/account/login` is the portal's sign-in, but nobody arriving from
 *    Freshdesk has an account here. Freshdesk's requester accounts were not
 *    migrated: every portal identity with a password was made here after the
 *    move (four on 2026-11-12, one of them verified).
 *  - `/<locale>/portal` is the ticket list, but Freshdesk's tickets were not
 *    imported and its ticket numbers are not ours, so the list would be empty
 *    behind that same sign-in — and `/portal/t/<n>` could open a different
 *    ticket of the customer's own that happens to share the number.
 *
 * The contact band offers what each of those readers came for, none of it
 * behind an account: the chat, which takes photos too, the support address,
 * the ticket card — and a Sign in card (My tickets, once signed in), so a
 * customer who does have an account here loses one tap. Once a public form is
 * built the ticket form's rule should become `/forms`, and once the portal opens
 * the sign-in's and the tickets' should become the portal's: one line each, and
 * no browser has kept the old answer.
 *
 * **What is not answered here.** Anything unmatched falls through to whatever
 * the proxy does with it, because sending every unknown URL to the home is the
 * well-known way to make a site unsearchable (`app/help/legacy/route.ts`). For
 * a locale path that is the help centre's 404. For a bare one it is the
 * console's sign-in, as before, until `KB_PUBLIC_HOST` names
 * `support.shipblu.com`; from then on it is the help centre's 404 there too. In particular: Freshdesk's search
 * autocomplete (`/support/search/solutions.json`), which a stale Freshdesk tab
 * still calls and which parses JSON, so an HTML page answers it no better than
 * a 404; its ticket and forum searches, which nothing here stands in for; and
 * `/support/sitemap.xml` and `/support/recaptcha`, which only crawlers ask for.
 *
 * The `/support` segment is Freshdesk's here as it was there: no console route
 * lives under it, and a help-centre page put at `/<locale>/support/…` later
 * would be shadowed by these rules.
 */

/**
 * A Freshdesk portal path: an optional language, then `/support`, whole, and
 * whatever follows it.
 *
 * The language must be one the help centre has, `/ar` or `/en`, optionally with
 * a region (`/en-US`) and in any case. ShipBlu's portal had only those two, and
 * they are all the request log shows. Any other two letters make the path no
 * portal path of ours, and it is left to the rest of the proxy. `/kb/support`
 * is the console's `/kb/[id]`, and this runs on every host, ahead of the
 * sign-in check, so a two-letter console route with a `support` beneath it must
 * not be answered here.
 *
 * Not the language reading `resolveLegacyPath` and `rewriteLegacyArticleLinks`
 * do, on purpose. Those read a preference out of a path already known to be
 * Freshdesk's, and fall back when it names a language we lack. This decides
 * whether a path is Freshdesk's at all.
 */
const PORTAL_PATH = /^(?:\/([A-Za-z]{2})(?:-[A-Za-z]{2})?)?\/support(\/.*)?$/;

/** Freshdesk's own language parameter, `en` or `en-US`. */
const URL_LOCALE = /^([A-Za-z]{2})(?:-[A-Za-z]{2})?$/;

/**
 * Freshdesk's category page, `/support/solutions/<id>`. Its article and folder
 * pages never reach this — the proxy hands them to the legacy route first — and
 * `\d+` could not read their `articles` or `folders` segment if they did.
 */
const CATEGORY_PAGE = /^\/solutions\/\d+(?:-[^/]*)?$/;

/**
 * Where a Freshdesk portal path's reader goes here — a path, with its query
 * and fragment — or null when it is not one of the portal pages answered for.
 *
 * The language is the path's own. Without one it is the `url_locale` parameter
 * Freshdesk puts on some of its links, when that names a language the help
 * centre has. Otherwise it is Arabic, as Freshdesk's own `/support/home` went
 * on to `/ar/support/home`. `Accept-Language` is never read: the help centre's
 * front door does not read it either, and one bookmark should not land in two
 * places.
 *
 * The rest of the query is dropped, as the legacy rewrite drops it: a `utm_`
 * tag, or its ticket form's `helpdesk_ticket[…]` prefill. The exception is a
 * search's `term`, which becomes our `q`.
 */
export function freshdeskPortalRedirect(pathname: string, query: URLSearchParams): string | null {
  const match = PORTAL_PATH.exec(pathname);
  if (!match) return null;

  const named = match[1]?.toLowerCase();
  if (named !== undefined && !isLocale(named)) return null;
  const asked = URL_LOCALE.exec(query.get('url_locale') ?? '')?.[1]?.toLowerCase();
  const locale: Locale = named ?? (isLocale(asked) ? asked : DEFAULT_LOCALE);
  const home = `/${locale}`;
  // Next answers a trailing slash with a 308 before the proxy runs, so this
  // rarely sees one; reading the page alike with or without it costs nothing.
  const page = (match[2] ?? '').replace(/\/$/, '');

  // The portal's front door, bare or by name; the knowledge-base index, whose
  // counterpart is the home's topic list; and a category. A category deserves
  // its own page here, `/<locale>/c/<slug>` — the importer kept the id in
  // `kb_categories.external_id` — but finding it is a lookup, which the proxy
  // does not make. Until the legacy route makes it, the home stands in, where
  // both public categories head the topic list. The internal employee guide's
  // id lands there too, which says nothing about it.
  if (page === '' || page === '/home' || page === '/solutions' || CATEGORY_PAGE.test(page)) {
    return home;
  }

  // The ticket form, every ticket page and the sign-in: the contact band, for
  // the reasons the header gives.
  if (
    page === '/tickets' ||
    page.startsWith('/tickets/') ||
    page === '/login' ||
    page === '/signup'
  ) {
    return `${home}#contact`;
  }

  // Freshdesk's search, and its results' articles tab. Only articles are
  // searchable here, so its ticket and forum tabs fall through. The term goes
  // across whole, as our search would take it typed into `?q=` directly.
  if (page === '/search' || page === '/search/solutions') {
    const term = (query.get('term') ?? '').trim();
    return term
      ? `${home}/search?${new URLSearchParams({ q: term }).toString()}`
      : `${home}/search`;
  }

  return null;
}
