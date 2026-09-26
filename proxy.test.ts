import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { LOCALES } from '@/lib/kb/locale';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
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
