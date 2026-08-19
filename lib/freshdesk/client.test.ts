import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { discoverLanguageCode, mapStatus, mapVisibility } from './client';

describe('mapVisibility', () => {
  it('maps the documented Freshdesk levels', () => {
    expect(mapVisibility(1)).toBe('public');
    expect(mapVisibility(2)).toBe('logged_in');
    expect(mapVisibility(3)).toBe('agents_only');
    expect(mapVisibility(4)).toBe('selected_companies');
  });

  it('treats anything unrecognised as agents-only, never public', () => {
    // The whole point of not writing this as `visibility === 3 ? ... : 'public'`:
    // a level Freshdesk adds later, or a null on a malformed row, must not
    // default to publishing internal content on the open internet.
    expect(mapVisibility(undefined)).toBe('agents_only');
    expect(mapVisibility(99)).toBe('agents_only');
    expect(mapVisibility(0)).toBe('agents_only');
  });
});

describe('mapStatus', () => {
  it('treats only Freshdesk status 2 as published', () => {
    expect(mapStatus(2)).toBe('published');
    expect(mapStatus(1)).toBe('draft');
    expect(mapStatus(undefined)).toBe('draft');
    expect(mapStatus(7)).toBe('draft');
  });
});

describe('discoverLanguageCode', () => {
  const ORIGINAL_ENV = process.env;
  const ORIGINAL_FETCH = globalThis.fetch;

  beforeEach(() => {
    process.env = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://localhost:5432/test',
      APP_SECRET: '0'.repeat(64),
      FRESHDESK_DOMAIN: 'shipblu.freshdesk.com',
      FRESHDESK_API_KEY: 'key',
    } as NodeJS.ProcessEnv;
    resetEnvCache();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    globalThis.fetch = ORIGINAL_FETCH;
    resetEnvCache();
  });

  /** Serves 200 for the listed paths and 404 for everything else. */
  function serve(found: string[]): string[] {
    const asked: string[] = [];

    globalThis.fetch = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname.replace('/api/v2', '');
      asked.push(path);

      return found.includes(path)
        ? new Response(JSON.stringify({ id: 1, name: 'x' }), { status: 200 })
        : new Response('not found', { status: 404 });
    }) as typeof fetch;

    return asked;
  }

  it('keeps looking past a category that has no translation', async () => {
    // The bug this exists for. ShipBlu's first Freshdesk category is an
    // internal staff guide nobody translated, so probing only the first
    // category found no English, skipped the entire English pass, and reported
    // a successful import of an Arabic-only knowledge base.
    serve(['/solutions/categories/222/en']);

    await expect(
      discoverLanguageCode('en', { categoryIds: [111, 222, 333], articleIds: [] }),
    ).resolves.toBe('en');
  });

  it('falls back to articles when no category is translated', async () => {
    // Freshdesk lets an article be translated while its category is not, so a
    // category-only probe can miss a language the account genuinely publishes.
    serve(['/solutions/articles/900/en']);

    await expect(
      discoverLanguageCode('en', { categoryIds: [111], articleIds: [900] }),
    ).resolves.toBe('en');
  });

  it('finds a regional code when the short form is not the one in use', async () => {
    serve(['/solutions/categories/111/en-GB']);

    await expect(discoverLanguageCode('en', { categoryIds: [111], articleIds: [] })).resolves.toBe(
      'en-GB',
    );
  });

  it('prefers the short code, and stops asking once something answers', async () => {
    const asked = serve(['/solutions/categories/111/en', '/solutions/categories/111/en-US']);

    await expect(
      discoverLanguageCode('en', { categoryIds: [111, 222], articleIds: [900] }),
    ).resolves.toBe('en');
    expect(asked).toEqual(['/solutions/categories/111/en']);
  });

  it('returns null when the language is genuinely absent, having tried every candidate', async () => {
    const asked = serve([]);

    await expect(
      discoverLanguageCode('en', { categoryIds: [111], articleIds: [900] }),
    ).resolves.toBeNull();
    expect(asked).toEqual([
      '/solutions/categories/111/en',
      '/solutions/articles/900/en',
      '/solutions/categories/111/en-US',
      '/solutions/articles/900/en-US',
      '/solutions/categories/111/en-GB',
      '/solutions/articles/900/en-GB',
    ]);
  });
});
