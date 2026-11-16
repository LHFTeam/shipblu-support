/**
 * The origin customers actually see.
 *
 * Sitemap and canonical URLs must use the help-centre hostname, not the Render
 * service URL — a sitemap advertising shipblu-support.onrender.com would get
 * that hostname indexed instead, and split the site's search ranking across two
 * domains.
 */
export function publicBaseUrl(): string {
  const host = process.env.KB_PUBLIC_HOST;
  if (host) return `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

  // Local development and any deployment whose KB_PUBLIC_HOST is unset — a
  // fact about the variable, not about whether a custom domain answers here.
  // Falling back keeps the pages working; only the absolute URLs are off.
  return appBaseUrl();
}

/** The app's own origin, `APP_URL`: where the console is served. */
function appBaseUrl(): string {
  return (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Whether a request's `Host` names the hostname `KB_PUBLIC_HOST` does: the
 * help centre's own, which serves no console. `proxy.ts` rewrites every
 * console path there under /help, where nothing answers, so a console page
 * reached on it renders once and 404s on the next click.
 *
 * Compared as the proxy has always compared it — the port dropped, both sides
 * lowered, no scheme stripped (`lib/env.ts` says the variable is a bare
 * hostname for that reason) — and the proxy asks this, so the host it serves
 * as the help centre and the host a sign-in treats as one cannot differ.
 */
export function isHelpCentreHost(host: string | null | undefined): boolean {
  const kbHost = process.env.KB_PUBLIC_HOST?.toLowerCase();
  if (!kbHost || !host) return false;
  return host.split(':')[0]?.toLowerCase() === kbHost;
}

/**
 * Where to send somebody who reached the console's door on the help centre's
 * host: `APP_URL`'s origin, or null when there is nowhere to send them —
 * `APP_URL` unset, unreadable, or naming the help centre's host itself, where a
 * link to the console would be the 404 it is meant to get them out of.
 *
 * Not `appBaseUrl()`, whose localhost fallback is right for a link in
 * development and wrong for a redirect in production.
 */
export function consoleBaseUrl(): string | null {
  const value = process.env.APP_URL;
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return isHelpCentreHost(url.host) ? null : url.origin;
}

/**
 * Whether a request's `Host` is the console's own address, `APP_URL`'s, on a
 * deployment whose help centre has a host of its own (`KB_PUBLIC_HOST`).
 *
 * Asked about the bare address alone (`proxy.ts`). Everywhere else the
 * console's host serves what any host does, the help centre's locale paths
 * included. Its `/` is the exception: on the help centre's host, or on a
 * deployment with one host for both, `/` is the public site's front door
 * (`app/page.tsx` says why), but somebody typing the console's own address
 * (desk.shipblu.com) is an agent, and the Arabic help centre is not what they
 * came for. False while `KB_PUBLIC_HOST` is unset, so development and staging
 * keep the front door they have.
 */
export function isConsoleHost(host: string | null | undefined): boolean {
  if (!process.env.KB_PUBLIC_HOST || !host) return false;
  const origin = consoleBaseUrl();
  if (!origin) return false;
  return new URL(origin).hostname === host.split(':')[0]?.toLowerCase();
}

/**
 * Typed on the one method it uses, so a server component can pass
 * `await headers()` and a route handler can pass `request.headers`. Copied from
 * `clientIpFrom` in `lib/http/rate-limit.ts` for the same reason it exists there: the
 * two ways of reading a request drift apart the moment one of them is inlined.
 */
type HeaderSource = { get(name: string): string | null };

/** A bare hostname, optionally with a port. Not a URL, not a list. */
const HOSTNAME = /^[a-z0-9.-]+(:\d+)?$/i;

/**
 * The origin this request actually arrived on.
 *
 * Distinct from `publicBaseUrl()` above, and both are needed: that one is the
 * address we *publish* — sitemap, canonical tags, `metadataBase` — while this
 * one is the address somebody is *using*. An agent opening an article from the
 * console wants the second, and a link they send a customer the first
 * (`articleOrigins`, below). The first is the hostname `KB_PUBLIC_HOST` names,
 * or `APP_URL`'s while it is unset, and nothing here can check that either
 * answers from this app. In August and September 2026 the variable named
 * `support.shipblu.com` while Freshdesk still served that host (it has answered
 * from this app since 2026-11-11), so every link built on it was a page that
 * 404'd, and no amount of the link being canonically correct helps the person
 * who clicked it. The host a request arrived on has just answered from this
 * app.
 *
 * Read off the `Host` header, never off `request.url`. Next resolves
 * `request.url` against the address the server is *bound* to, so behind Render
 * a request for any hostname reports `http://localhost:10000/...` — the bug
 * that once redirected signed-out agents to a dead address on their own
 * machine. `lib/http/redirect.ts` carries the long version.
 *
 * The host is attacker-controllable in principle, and this string ends up in a
 * link shown to a customer in the widget, so it is worth being explicit about
 * why that is bounded here: Render's edge routes to this service only for the
 * hostnames configured on it, so a forged `Host` does not arrive in the first
 * place, and anything that is not a bare hostname is rejected below. An
 * allowlist would be the belt-and-braces answer, but the only entries it could
 * hold are `KB_PUBLIC_HOST` and the host of `APP_URL` — and `APP_URL` is
 * `sync: false`, so it cannot be checked from the repository at all.
 */
export function requestBaseUrl(
  headers: HeaderSource,
  fallback: () => string = publicBaseUrl,
): string {
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!host || !HOSTNAME.test(host)) return fallback();

  // A comma-separated list when more than one proxy has handled it; the first
  // entry is the scheme the client actually used.
  const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwarded || (host.startsWith('localhost') ? 'http' : 'https');

  return `${scheme}://${host}`;
}

/**
 * An article's absolute URL on `origin`, for every absolute address we build
 * for one: the sitemap's, the widget's, the console's and the knowledge
 * panel's. The slug is the stored one, which can be Arabic, so it is
 * percent-encoded here once rather than at each call; a relative `href` needs
 * none of this, since the browser encodes it.
 */
export function articleUrl(origin: string, locale: string, slug: string): string {
  return `${origin}/${locale}/a/${encodeURI(slug)}`;
}

/** Where a console knowledge link is read, and where one an agent sends points. */
export type ArticleOrigins = { read: string; send: string };

/** An article's two console links: `url` to open, `sendUrl` to send a customer. */
export type ArticleLinks = { url: string; sendUrl: string };

/**
 * The pair every console surface showing an article link builds, read on
 * `origins.read` and sent on `origins.send` (`articleOrigins` says why), so
 * the knowledge panel and the article page cannot take them the other way
 * round.
 */
export function articleLinks(origins: ArticleOrigins, locale: string, slug: string): ArticleLinks {
  return {
    url: articleUrl(origins.read, locale, slug),
    sendUrl: articleUrl(origins.send, locale, slug),
  };
}

/**
 * The two hosts a knowledge-base link takes in the console.
 *
 * `read` is the host the agent is on, for an article they open themselves.
 * Their console session lives on that host alone, and on another host the help
 * centre takes them for a customer and draws the chat launcher over the
 * article, one click from a webchat ticket against their own queue
 * (`lib/widget/audience.ts`).
 *
 * `send` is the published host, for the link they insert into a reply. The
 * customer keeps that link, in a thread, an inbox or a screenshot, so it is an
 * address we publish, as the sitemap, the canonicals and the survey and portal
 * links are. Built on the agent's host it would name wherever the console is
 * served, which is never the help centre's host once `KB_PUBLIC_HOST` names
 * one: the proxy serves no console there. It rests on the variable naming a
 * host that answers from this app, which nothing checks (`requestBaseUrl` says
 * what that cost in 2026). A wrong value breaks every address we publish at
 * once, and is mended in the variable rather than link by link.
 *
 * With no host to read, `read` falls back to the console's own origin rather
 * than the published one, which is the one host the agent cannot be signed in
 * on once the variable names it.
 */
export function articleOrigins(headers: HeaderSource): ArticleOrigins {
  return { read: requestBaseUrl(headers, appBaseUrl), send: publicBaseUrl() };
}
