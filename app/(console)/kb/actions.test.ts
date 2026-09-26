import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The knowledge base actions take an article's, a folder's, a category's or a
 * version's id from a form field. A malformed one reached Postgres, which
 * answers with error 22P02 rather than with no rows — the action threw instead
 * of saying the article was not found. The database here fails loudly if asked
 * anything, so each case below has to be answered before a query is built.
 */

const untouchable = () => {
  throw new Error('the database was asked about an id that cannot exist');
};
const db = {
  select: vi.fn(untouchable),
  insert: vi.fn(untouchable),
  update: vi.fn(untouchable),
  delete: vi.fn(untouchable),
  transaction: vi.fn(untouchable),
};

vi.mock('@/db/client', () => ({ db }));
vi.mock('@/lib/auth/guard', () => ({
  requirePermission: async () => ({ id: 'admin-1', role: 'admin' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirected');
  },
}));

const actions = await import('./actions');

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const INITIAL = { error: null };
const MALFORMED = 'not-a-uuid';
const WELL_FORMED = '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44';

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockClear();
});

function expectNoQuery() {
  for (const fn of Object.values(db)) expect(fn).not.toHaveBeenCalled();
}

describe('knowledge base actions given an id no row can have', () => {
  it.each([
    [
      'setArticleStatus',
      () => actions.setArticleStatus(INITIAL, form({ id: MALFORMED, status: 'draft' })),
    ],
    ['deleteArticle', () => actions.deleteArticle(INITIAL, form({ id: MALFORMED }))],
    [
      'linkTranslation',
      () => actions.linkTranslation(INITIAL, form({ id: MALFORMED, otherId: 'also-not-one' })),
    ],
    [
      'restoreVersion',
      () => actions.restoreVersion(INITIAL, form({ id: MALFORMED, versionId: WELL_FORMED })),
    ],
  ])('%s says the article was not found, without querying', async (_name, run) => {
    await expect(run()).resolves.toEqual({ error: 'Article not found' });
    expectNoQuery();
  });

  it('restoreVersion refuses a malformed version id before reading the article', async () => {
    await expect(
      actions.restoreVersion(INITIAL, form({ id: WELL_FORMED, versionId: MALFORMED })),
    ).resolves.toEqual({ error: 'That version no longer exists' });
    expectNoQuery();
  });

  it('saveArticle asks for a folder when the one it was given cannot exist', async () => {
    await expect(
      actions.saveArticle(INITIAL, form({ title: 'Returns', folderId: MALFORMED })),
    ).resolves.toEqual({ error: 'Choose a folder' });
    expectNoQuery();
  });

  it('createFolder asks for a category when the one it was given cannot exist', async () => {
    await expect(
      actions.createFolder(INITIAL, form({ name: 'Shipping', categoryId: MALFORMED })),
    ).resolves.toEqual({ error: 'Choose a category' });
    expectNoQuery();
  });
});
