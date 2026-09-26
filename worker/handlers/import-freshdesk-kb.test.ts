import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFetch } from '@/lib/testing/fetch';
import { withTestEnv } from '@/lib/testing/env';

/**
 * One item's failure is recorded and the import carries on; a Freshdesk that
 * stopped answering ends the run. Carrying on through an unanswered request
 * spent the full deadline again on every request left — over an hour for a
 * few hundred articles, holding the worker's batch the whole time.
 */

vi.mock('@/db/client', async () => ({ db: (await import('@/lib/testing/fake-db')).fakeDb }));

const listCategories = vi.fn();
const listFolders = vi.fn();
const listArticles = vi.fn();

// Every call that would reach Freshdesk is replaced; `FreshdeskError` and the
// pure mappers stay real.
vi.mock('@/lib/freshdesk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/freshdesk/client')>()),
  listCategories,
  listFolders,
  listArticles,
  discoverLanguageCode: async () => null,
  getTranslatedArticle: async () => null,
  getTranslatedCategory: async () => null,
  getTranslatedFolder: async () => null,
}));

const { FreshdeskError } = await import('@/lib/freshdesk/client');
const { refuseEveryQuery } = await import('@/lib/testing/fake-db');
const { importFreshdeskKb } = await import('./import-freshdesk-kb');

withTestEnv({ FRESHDESK_DOMAIN: 'shipblu.freshdesk.com', FRESHDESK_API_KEY: 'key' });

beforeEach(() => {
  refuseEveryQuery();
  listCategories.mockReset().mockResolvedValue([{ id: 1, name: 'Shipping' }]);
  listFolders.mockReset().mockResolvedValue([
    { id: 10, category_id: 1, name: 'Tracking' },
    { id: 11, category_id: 1, name: 'Returns' },
    { id: 12, category_id: 1, name: 'Payments' },
  ]);
  listArticles.mockReset();
  stubFetch(() => {
    throw new Error('a test reached the network');
  });
});

describe('importFreshdeskKb reading the tree', () => {
  it('stops at the first request Freshdesk did not answer, and asks for nothing more', async () => {
    listArticles.mockRejectedValue(
      new FreshdeskError('Freshdesk /solutions/folders/10/articles did not answer in 15s', 0, true),
    );

    await expect(importFreshdeskKb()).rejects.toThrow('did not answer in 15s');
    expect(listArticles).toHaveBeenCalledTimes(1);
  });

  it('records a folder Freshdesk refused, and goes on to the next', async () => {
    listArticles.mockRejectedValue(
      new FreshdeskError('Freshdesk /solutions/folders/10/articles failed (404): gone', 404, false),
    );

    // Nothing is written: each folder is refused, and the fake database would
    // throw on any query. The run ends by reporting what failed.
    await expect(importFreshdeskKb()).rejects.toThrow(/item\(s\) failed to import/);
    expect(listArticles).toHaveBeenCalledTimes(3);
  });
});
