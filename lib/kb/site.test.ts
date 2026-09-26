import { describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { publicBaseUrl, requestBaseUrl } from './site';

/** Just enough of `Headers` for the one method `requestBaseUrl` calls. */
function headers(entries: Record<string, string>) {
  const lower = Object.fromEntries(
    Object.entries(entries).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

describe('requestBaseUrl', () => {
  // The fallback reads KB_PUBLIC_HOST and APP_URL, so the tests below own them
  // rather than inherit whatever the shell happened to export.
  withTestEnv({ APP_URL: 'https://app.example.com' });

  it('uses the host the request actually arrived on', () => {
    expect(requestBaseUrl(headers({ host: 'shipblu-support.onrender.com' }))).toBe(
      'https://shipblu-support.onrender.com',
    );
  });

  it('does not follow the published host when they disagree', () => {
    // The whole point: KB_PUBLIC_HOST can name a domain that does not serve
    // this app yet, and an agent clicking a link needs the one that does.
    setTestEnv({ KB_PUBLIC_HOST: 'support.shipblu.com' });

    expect(requestBaseUrl(headers({ host: 'shipblu-support.onrender.com' }))).toBe(
      'https://shipblu-support.onrender.com',
    );
    expect(publicBaseUrl()).toBe('https://support.shipblu.com');
  });

  it('prefers x-forwarded-host, which is what a proxy rewrites', () => {
    expect(
      requestBaseUrl(headers({ host: 'internal:10000', 'x-forwarded-host': 'help.example.com' })),
    ).toBe('https://help.example.com');
  });

  it('takes the first scheme when several proxies have appended one', () => {
    expect(
      requestBaseUrl(headers({ host: 'help.example.com', 'x-forwarded-proto': 'https, http' })),
    ).toBe('https://help.example.com');
  });

  it('serves localhost over http, so a dev link is clickable', () => {
    expect(requestBaseUrl(headers({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
  });

  it('falls back to the published origin when there is no host to read', () => {
    expect(requestBaseUrl(headers({}))).toBe('https://app.example.com');
  });

  it('rejects anything that is not a bare hostname', () => {
    // This string is pasted into a message sent to a customer, so a header
    // carrying a path, a scheme or a second host must not become the origin —
    // it falls back rather than building something an attacker chose.
    for (const host of ['evil.com/path', 'https://evil.com', 'a,b', 'evil.com evil2.com', '']) {
      expect(requestBaseUrl(headers({ host }))).toBe('https://app.example.com');
    }
  });
});
