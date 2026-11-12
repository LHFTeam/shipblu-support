import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  normalizeMetadataPageToRoute,
  normalizeMetadataRoute,
} from 'next/dist/lib/metadata/get-metadata-route';
import {
  DEFAULT_METADATA_ROUTE_EXTENSIONS,
  STATIC_METADATA_IMAGES,
  isMetadataRouteFile,
} from 'next/dist/lib/metadata/is-metadata-route';
import { normalizeAppPath } from 'next/dist/shared/lib/router/utils/app-paths';
import { SESSION_COOKIE } from '@/lib/auth/cookie';
import { LEGACY_PATH_HEADER } from '@/lib/kb/legacy-path';
import { LOCALES } from '@/lib/kb/locale';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { GET as robotsTxt } from '@/app/help/robots.txt/route';
import proxy from './proxy';

/**
 * Host routing, which has no other way of being checked before the custom
 * domain is live.
 *
 * The failure this is here to prevent is a quiet one: a path that should be
 * served as itself gets rewritten under /help instead, 404s, and does so only
 * on the hostname customers use — everything keeps working on the Render
 * service URL, where the rule never applies.
 */

const KB_HOST = 'support.shipblu.com';

/** A request as it actually arrives: the routing turns on the Host header. */
function visit(url: string, cookie?: string): Response {
  const target = new URL(url);
  const headers = new Headers({ host: target.host });
  if (cookie) headers.set('cookie', cookie);

  return proxy(new NextRequest(target, { headers }));
}

/** The path a rewrite landed on, or null if the request was passed through. */
function rewrittenTo(response: Response): string | null {
  const destination = response.headers.get('x-middleware-rewrite');
  return destination ? new URL(destination).pathname : null;
}

// A KB_PUBLIC_HOST exported in the shell would decide which hostname below is
// the help centre's.
withTestEnv();

describe('the help-centre hostname', () => {
  beforeEach(() => setTestEnv({ KB_PUBLIC_HOST: KB_HOST }));

  it('rewrites a public page under /help', () => {
    expect(rewrittenTo(visit(`https://${KB_HOST}/en/a/where-is-my-parcel`))).toBe(
      '/help/en/a/where-is-my-parcel',
    );
    expect(rewrittenTo(visit(`https://${KB_HOST}/`))).toBe('/help');
  });

  it('serves the chat widget as itself', () => {
    // Both halves: the host page loads the snippet, the snippet frames the
    // page. Rewritten under /help either would 404 and the help centre would
    // have a launcher that opens an empty box — or no launcher at all.
    expect(rewrittenTo(visit(`https://${KB_HOST}/widget/embed.js`))).toBeNull();
    expect(rewrittenTo(visit(`https://${KB_HOST}/widget?locale=ar`))).toBeNull();
    expect(rewrittenTo(visit(`https://${KB_HOST}/api/widget/session`))).toBeNull();
  });
});

describe('every other hostname', () => {
  it('still rewrites a locale-prefixed path under /help', () => {
    expect(rewrittenTo(visit('https://shipblu-support.onrender.com/ar'))).toBe('/help/ar');
  });

  it('rewrites every locale the help centre has, and only as a whole segment', () => {
    for (const locale of LOCALES) {
      expect(rewrittenTo(visit(`https://shipblu-support.onrender.com/${locale}/a/x`))).toBe(
        `/help/${locale}/a/x`,
      );
    }
    // A console path that merely starts with a locale's letters is not one.
    expect(rewrittenTo(visit('https://shipblu-support.onrender.com/area'))).toBeNull();
  });

  // A crawler asks a host for both at its root, and both are the help
  // centre's. They answered 404 here until the proxy sent them to it.
  it('serves robots.txt and the sitemap to a visitor with no session', () => {
    for (const file of ['/robots.txt', '/sitemap.xml']) {
      const response = visit(`https://shipblu-support.onrender.com${file}`);
      expect(rewrittenTo(response)).toBe(`/help${file}`);
      expect(response.status).not.toBe(307);
    }
    // The files themselves, not a path beneath one.
    expect(rewrittenTo(visit('https://shipblu-support.onrender.com/robots.txt/x'))).toBeNull();
  });

  it('lets a signed-out visitor reach the widget but not the console', () => {
    expect(visit('https://shipblu-support.onrender.com/widget').status).not.toBe(307);
    expect(visit('https://shipblu-support.onrender.com/inbox').status).toBe(307);
  });

  it('lets the health check reach the render probe over the loopback', () => {
    // `/probe` is rendered by /api/health, which carries no session. A 307 here
    // would send the check to /login, whose HTML is a 200 as well, so only the
    // missing marker would say anything was wrong.
    expect(visit('http://127.0.0.1:10000/probe').status).not.toBe(307);
    expect(rewrittenTo(visit('http://127.0.0.1:10000/probe'))).toBeNull();
  });
});

/**
 * The favicon, and every other file a page's `<head>` names from the root.
 *
 * `/icon.svg` answered 307 to /login on both hosts until 2026-11-12, so no
 * signed-out reader of the help centre saw the icon. Once `KB_PUBLIC_HOST`
 * names the domain, the help-centre host would have rewritten it to
 * `/help/icon.svg`, which 404s. The routes are named by Next's own functions,
 * from the files `app/` holds, so a new icon is checked the day it is added,
 * under the name Next serves it at.
 */
describe("the files a page's head names", () => {
  const DRAWN_BY_CODE = new RegExp(`\\.(?:${DEFAULT_METADATA_ROUTE_EXTENSIONS.join('|')})$`);
  const IMAGE_NAMES: readonly string[] = Object.values(STATIC_METADATA_IMAGES).map(
    (image) => image.filename,
  );

  /**
   * Where Next serves an `app/` file. One drawn by code loses its extension,
   * and an image drawn by code that exports `generateImageMetadata` is served
   * once per id beneath that instead (`/icon/small`). Next tells the two apart
   * by the file's exports, so an image drawn by code is checked both ways.
   */
  function routesOf(file: string): string[] {
    const page = normalizeMetadataRoute(file.replace(DRAWN_BY_CODE, ''));
    const name = file
      .slice(file.lastIndexOf('/') + 1)
      .replace(DRAWN_BY_CODE, '')
      .replace(/\d$/, '');
    const perId = DRAWN_BY_CODE.test(file) && IMAGE_NAMES.includes(name) ? [false, true] : [false];
    return perId.map((dynamic) =>
      normalizeAppPath(normalizeMetadataPageToRoute(page, dynamic)).replace(
        '[__metadata_id__]',
        'small',
      ),
    );
  }

  /**
   * The files directly in `app/` and in its route groups, which add no segment.
   * A file deeper down is served under its segment (`/inbox/icon.png`), which
   * is that segment's to make public or not. `robots` and `sitemap` are the
   * help centre's, and are rewritten to it on every host (above).
   */
  function headFiles(dir: string, segment = ''): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = `${segment}/${entry.name}`;
      if (entry.isDirectory()) {
        return /^\(.+\)$/.test(entry.name) ? headFiles(`${dir}/${entry.name}`, file) : [];
      }
      const isHeadFile =
        isMetadataRouteFile(file, DEFAULT_METADATA_ROUTE_EXTENSIONS, true) &&
        !/^(?:robots|sitemap)\./.test(entry.name);
      return isHeadFile ? [file] : [];
    });
  }

  const present = headFiles(fileURLToPath(new URL('./app', import.meta.url)));

  // The shapes the pattern claims beyond what `app/` holds today: a numbered
  // variant, a file in a route group, an image drawn by code, and the rest of
  // Next's head files.
  const possible = [
    '/apple-icon.png',
    '/icon1.png',
    '/(auth)/icon.png',
    '/icon.tsx',
    '/(auth)/apple-icon.tsx',
    '/opengraph-image.tsx',
    '/twitter-image.jpg',
    '/favicon.ico',
    '/manifest.ts',
    '/manifest.json',
  ];

  it('include the icon every page links, so the checks below cannot pass on nothing', () => {
    expect(present).toContain('/icon.svg');
    expect(routesOf('/icon.svg')).toEqual(['/icon.svg']);
    expect(routesOf('/icon.tsx')).toEqual(['/icon', '/icon/small']);
  });

  it('are what Next calls a metadata file, each of them', () => {
    for (const file of possible) {
      expect(isMetadataRouteFile(file, DEFAULT_METADATA_ROUTE_EXTENSIONS, true), file).toBe(true);
    }
  });

  it.each([
    ['the Render host, before KB_PUBLIC_HOST is set', 'shipblu-support.onrender.com', undefined],
    ['the domain, before KB_PUBLIC_HOST is set', KB_HOST, undefined],
    ['the Render host, once KB_PUBLIC_HOST is set', 'shipblu-support.onrender.com', KB_HOST],
    ['the help-centre host', KB_HOST, KB_HOST],
  ])('are served as themselves to a signed-out visitor on %s', (_, host, kbHost) => {
    setTestEnv({ KB_PUBLIC_HOST: kbHost });
    for (const route of [...present, ...possible].flatMap(routesOf)) {
      // Neither redirected to /login nor rewritten under /help.
      expect(visit(`https://${host}${route}`).headers.get('x-middleware-next'), route).toBe('1');
    }
  });

  it('are the files themselves, at the root, and nothing that starts like one', () => {
    for (const path of [
      '/inbox/icon.svg',
      '/icon.svg/x',
      '/icon/small/x',
      '/icons',
      '/iconography',
      '/icon.svg.map',
    ]) {
      expect(visit(`https://shipblu-support.onrender.com${path}`).status, path).toBe(307);
    }
  });
});

/**
 * The `Sitemap:` line names `publicBaseUrl()`'s host, which is the Render host
 * until the domain moves and the help centre's after. Either way a crawler
 * reading it must reach the sitemap, so the address is followed through this
 * proxy as the crawler would follow it.
 */
describe('the sitemap robots.txt advertises', () => {
  it.each([
    [
      'the Render host, before the domain moves',
      { APP_URL: 'https://shipblu-support.onrender.com' },
    ],
    ['the help-centre host, after it', { KB_PUBLIC_HOST: KB_HOST }],
  ])('is an address this proxy serves the sitemap at, on %s', async (_, env) => {
    setTestEnv(env);
    const robots = await (await robotsTxt()).text();
    const sitemap = /^Sitemap: (\S+)$/m.exec(robots)?.[1];

    expect(sitemap).toBeDefined();
    if (!sitemap) return;
    expect(rewrittenTo(visit(sitemap))).toBe('/help/sitemap.xml');
  });
});

/**
 * Freshdesk's article and folder URLs, on whichever host they arrive.
 *
 * The rewrite used to put the path in `?path=`, which the route handler never
 * saw: Next hands it the request as it arrived, so every one of these answered
 * the route's own 404 (PROJECT-STATE §6.115). What reaches the handler is a
 * header set on the rewritten request, which Next sends as
 * `x-middleware-request-<name>` and lists in `x-middleware-override-headers`.
 */
describe('Freshdesk URLs', () => {
  const SHAPES = [
    '/support/solutions/articles/154000189336',
    '/support/solutions/articles/154000189336-packaging-guidelines',
    '/a/solutions/articles/154000189336',
    '/solutions/articles/154000189336',
    '/en/support/solutions/articles/154000189336',
    '/support/solutions/folders/154000050001',
  ];

  const legacyPathSent = (response: Response) =>
    response.headers.get(`x-middleware-request-${LEGACY_PATH_HEADER}`);

  for (const host of [KB_HOST, 'shipblu-support.onrender.com']) {
    it(`hands each shape to the legacy route in a header, on ${host}`, () => {
      setTestEnv({ KB_PUBLIC_HOST: KB_HOST });
      for (const shape of SHAPES) {
        const response = visit(`https://${host}${shape}`);
        expect(rewrittenTo(response)).toBe('/help/legacy');
        expect(legacyPathSent(response)).toBe(shape);
        expect(response.headers.get('x-middleware-override-headers')).toContain(LEGACY_PATH_HEADER);
      }
    });
  }

  it('sends the path it was asked for, not one the client claimed', () => {
    const target = new URL('https://shipblu-support.onrender.com/solutions/articles/1');
    const headers = new Headers({ host: target.host, [LEGACY_PATH_HEADER]: '/elsewhere' });
    expect(legacyPathSent(proxy(new NextRequest(target, { headers })))).toBe(
      '/solutions/articles/1',
    );
  });

  it('reaches the legacy route directly on the help centre host as /legacy, query kept', () => {
    setTestEnv({ KB_PUBLIC_HOST: KB_HOST });
    const response = visit(`https://${KB_HOST}/legacy?path=%2Fsolutions%2Farticles%2F1`);
    expect(rewrittenTo(response)).toBe('/help/legacy');
    expect(new URL(response.headers.get('x-middleware-rewrite')!).searchParams.get('path')).toBe(
      '/solutions/articles/1',
    );
  });

  it('leaves the query off the rewrite, where nothing would read it', () => {
    const destination = visit(
      'https://shipblu-support.onrender.com/support/solutions/articles/1?utm=x',
    ).headers.get('x-middleware-rewrite');
    expect(new URL(destination!).search).toBe('');
  });
});

/**
 * Freshdesk's portal pages: its home, knowledge-base index, ticket form,
 * sign-in and search, which customers' bookmarks and Freshdesk's emails still
 * name (`lib/kb/freshdesk-portal.ts`).
 *
 * Measured on production before this rule: the bare shapes answered the
 * console's 307 to `/login`, the locale ones the help centre's 404, and with
 * `KB_PUBLIC_HOST` set the catch-all would have made every one a 404. So each
 * is checked on the help centre's host and on the Render host, with the
 * variable set and unset: the rule has to run before all of those see it.
 */
describe("Freshdesk's portal pages", () => {
  const RENDER_HOST = 'shipblu-support.onrender.com';
  const HOSTS = [
    ['the help-centre host', KB_HOST, { KB_PUBLIC_HOST: KB_HOST }],
    ['the Render host, KB_PUBLIC_HOST set', RENDER_HOST, { KB_PUBLIC_HOST: KB_HOST }],
    ['the Render host, KB_PUBLIC_HOST unset', RENDER_HOST, {}],
  ] as const;

  /** A Freshdesk path, and where its reader lands here. */
  const ANSWERS: [string, string][] = [
    // The front door, as Freshdesk's own `/` sent it and as bookmarks hold it.
    ['/support/home', '/ar'],
    ['/ar/support/home', '/ar'],
    ['/en/support/home', '/en'],
    ['/support', '/ar'],
    ['/en/support', '/en'],
    // The knowledge-base index, and a category standing in until it is looked up.
    ['/support/solutions', '/ar'],
    ['/ar/support/solutions', '/ar'],
    ['/en/support/solutions', '/en'],
    ['/ar/support/solutions/154000297679', '/ar'],
    ['/en/support/solutions/154000297680', '/en'],
    // The ticket form, a ticket from a Freshdesk email, the sign-in and sign-up.
    ['/support/tickets/new', '/ar#contact'],
    ['/ar/support/tickets/new', '/ar#contact'],
    ['/en/support/tickets/new', '/en#contact'],
    ['/support/tickets', '/ar#contact'],
    ['/en/support/tickets/44105', '/en#contact'],
    ['/support/login', '/ar#contact'],
    ['/ar/support/login', '/ar#contact'],
    ['/ar/support/signup', '/ar#contact'],
    ['/en/support/signup', '/en#contact'],
    // A language with a region reads as its language; one the help centre lacks
    // reads as Arabic, as no language at all does.
    ['/en-US/support/home', '/en'],
    ['/fr/support/home', '/ar'],
    ['/support/home/', '/ar'],
  ];

  /** Where a redirect sends the browser, and on which host. */
  function landing(response: Response): { host: string; to: string } | null {
    const location = response.headers.get('location');
    if (!location) return null;
    const url = new URL(location);
    return { host: url.host, to: url.pathname + url.search + url.hash };
  }

  for (const [label, host, env] of HOSTS) {
    it(`sends each one to its counterpart here, with a 302, on ${label}`, () => {
      setTestEnv(env);
      for (const [path, to] of ANSWERS) {
        const response = visit(`https://${host}${path}`);
        // The path rides along so a failure names the shape that failed.
        expect({ path, status: response.status }).toEqual({ path, status: 302 });
        expect({ path, landing: landing(response) }).toEqual({ path, landing: { host, to } });
        expect(rewrittenTo(response)).toBeNull();
      }
    });
  }

  // Never a 301 while Freshdesk could still take the name back, and never a 307
  // or 308, which would re-send a stale Freshdesk form's body — a password,
  // from the sign-in — to wherever this points.
  it('answers every one with a 302, whatever the method', () => {
    for (const method of ['GET', 'HEAD', 'POST']) {
      const target = new URL(`https://${RENDER_HOST}/support/login`);
      const request = new NextRequest(target, { method, headers: { host: target.host } });
      expect(proxy(request).status).toBe(302);
    }
  });

  it('answers the same for a signed-in agent, ahead of the console', () => {
    const response = visit(`https://${RENDER_HOST}/support/home`, `${SESSION_COOKIE}=x`);
    expect(response.status).toBe(302);
    expect(landing(response)?.to).toBe('/ar');
  });

  it("carries a Freshdesk search's term over as ours, and nothing else", () => {
    setTestEnv({ KB_PUBLIC_HOST: KB_HOST });
    const term = 'شوبيفاى';
    const response = visit(
      `https://${KB_HOST}/ar/support/search?term=${encodeURIComponent(term)}&page=2`,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/ar/search');
    expect([...location.searchParams]).toEqual([['q', term]]);
    // Arabic in a `Location` is a 500 unless it is encoded (`lib/http/redirect.ts`).
    expect(response.headers.get('location')).toMatch(/^[\x20-\x7e]+$/);

    expect(landing(visit(`https://${KB_HOST}/en/support/search/solutions?term=cod`))?.to).toBe(
      '/en/search?q=cod',
    );
    expect(landing(visit(`https://${KB_HOST}/support/search`))?.to).toBe('/ar/search');
    expect(landing(visit(`https://${KB_HOST}/support/search?term=%20%20`))?.to).toBe('/ar/search');
  });

  it('drops the rest of the query, which nothing here reads', () => {
    for (const path of [
      '/support/home?utm_source=whatsapp&url_locale=en',
      '/support/tickets/new?helpdesk_ticket%5Bsubject%5D=x',
    ]) {
      expect(landing(visit(`https://${RENDER_HOST}${path}`))?.to).toMatch(/^\/ar(#contact)?$/);
    }
  });

  it('still hands Freshdesk articles and folders to the legacy route, language and all', () => {
    setTestEnv({ KB_PUBLIC_HOST: KB_HOST });
    for (const host of [KB_HOST, RENDER_HOST]) {
      for (const path of [
        '/ar/support/solutions/articles/154000189336',
        '/ar/support/solutions/folders/154000518595',
        '/en/support/solutions/folders/154000746959/page/2',
      ]) {
        expect({ path, to: rewrittenTo(visit(`https://${host}${path}`)) }).toEqual({
          path,
          to: '/help/legacy',
        });
      }
    }
  });

  // Sending every unknown URL to the home is how a site makes itself
  // unsearchable, so what has no counterpart here keeps its 404.
  it('leaves what has no counterpart here to the help centre’s 404', () => {
    setTestEnv({ KB_PUBLIC_HOST: KB_HOST });
    for (const path of [
      '/ar/support/search/solutions.json',
      '/en/support/search/tickets',
      '/en/support/search/topics',
      '/ar/support/solutions/articles/most-viewed',
      '/en/support/discussions',
      '/support/sitemap.xml',
      '/support/recaptcha',
    ]) {
      const response = visit(`https://${KB_HOST}${path}`);
      expect({ path, location: response.headers.get('location') }).toEqual({
        path,
        location: null,
      });
      expect(rewrittenTo(response)).toBe(`/help${path}`);
    }
  });

  it('reads `support` only as a whole segment', () => {
    expect(visit(`https://${RENDER_HOST}/supporting`).status).toBe(307);
    expect(rewrittenTo(visit(`https://${RENDER_HOST}/ar/supporting`))).toBe('/help/ar/supporting');
  });
});
