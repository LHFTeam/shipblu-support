import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubFetch } from '@/lib/testing/fetch';
import { withTestEnv } from '@/lib/testing/env';
import {
  discoverLanguageCode,
  FreshdeskError,
  getTranslatedCategory,
  mapStatus,
  mapVisibility,
} from './client';

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
  withTestEnv({ FRESHDESK_DOMAIN: 'shipblu.freshdesk.com', FRESHDESK_API_KEY: 'key' });

  /** Serves 200 for the listed paths and 404 for everything else. */
  function serve(found: string[]): string[] {
    const asked: string[] = [];

    stubFetch(async (url: string | URL) => {
      const path = new URL(String(url)).pathname.replace('/api/v2', '');
      asked.push(path);

      return found.includes(path)
        ? new Response(JSON.stringify({ id: 1, name: 'x' }), { status: 200 })
        : new Response('not found', { status: 404 });
    });

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

/**
 * The importer runs as a job, and a request with no deadline of its own holds
 * its worker slot for the five minutes `fetch` waits before it gives up — when
 * the worker still ran in batches, every queued job behind it, every send and
 * every sync, waited as long.
 */
describe('a Freshdesk request', () => {
  withTestEnv({ FRESHDESK_DOMAIN: 'shipblu.freshdesk.com', FRESHDESK_API_KEY: 'key' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Answers like `fetch` does: a signal that has fired rejects with its reason. */
  function serveUnlessAborted(): void {
    stubFetch(async (_url: string | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(JSON.stringify({ id: 1, name: 'x' }), { status: 200 });
    });
  }

  it('carries a deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    serveUnlessAborted();

    await getTranslatedCategory(1, 'ar');

    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it('that does not answer in time fails as a retryable Freshdesk error that says so', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    );
    serveUnlessAborted();

    const failure = getTranslatedCategory(1, 'ar');

    await expect(failure).rejects.toBeInstanceOf(FreshdeskError);
    await expect(failure).rejects.toMatchObject({ isTransient: true });
    await expect(failure).rejects.toThrow(/did not answer in 15s/);
  });

  /**
   * A DNS failure or a reset says the same thing a deadline does: Freshdesk did
   * not answer. It surfaced as a bare `TypeError: fetch failed`, which the
   * importer could not tell from an item's own failure.
   */
  it('that cannot reach Freshdesk fails as a Freshdesk error that never got an answer', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });

    const failure = getTranslatedCategory(1, 'ar');

    await expect(failure).rejects.toBeInstanceOf(FreshdeskError);
    await expect(failure).rejects.toMatchObject({ status: 0, isTransient: true });
    await expect(failure).rejects.toThrow(/unreachable: fetch failed/);
  });

  /**
   * The signal governs the body as well as the status. A deadline passing
   * mid-body rejected with the signal's own reason, which is not a
   * `FreshdeskError` and names no path.
   */
  it('says the same when the deadline passes while the answer is arriving', async () => {
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
              );
            },
          }),
          { status: 200 },
        ),
    );

    const failure = getTranslatedCategory(1, 'ar');

    await expect(failure).rejects.toBeInstanceOf(FreshdeskError);
    await expect(failure).rejects.toMatchObject({ isTransient: true });
    await expect(failure).rejects.toThrow(/did not answer in 15s/);
  });
});
