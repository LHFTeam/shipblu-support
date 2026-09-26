import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerNoRows,
  expectNoQuery,
  expectNoWrite,
  formData as form,
  refuseEveryQuery,
} from '@/lib/testing/fake-db';

/**
 * The knowledge base actions take an article's, a folder's, a category's or a
 * version's id from a form field. A malformed one reached Postgres, which
 * answers with error 22P02 rather than with no rows — the action threw instead
 * of saying the article was not found.
 */

vi.mock('@/db/client', async () => ({ db: (await import('@/lib/testing/fake-db')).fakeDb }));
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

const INITIAL = { error: null };
const MALFORMED = 'not-a-uuid';
const WELL_FORMED = '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44';

beforeEach(() => {
  refuseEveryQuery();
});

describe('knowledge base actions given an id no row can have', () => {
  it.each([
    [
      'setArticleStatus',
      () => actions.setArticleStatus(INITIAL, form({ id: MALFORMED, status: 'draft' })),
    ],
    ['deleteArticle', () => actions.deleteArticle(INITIAL, form({ id: MALFORMED }))],
    [
      'restoreVersion',
      () => actions.restoreVersion(INITIAL, form({ id: MALFORMED, versionId: WELL_FORMED })),
    ],
    [
      'saveArticle, editing',
      () =>
        actions.saveArticle(
          INITIAL,
          form({ id: MALFORMED, title: 'Returns', folderId: WELL_FORMED }),
        ),
    ],
  ])('%s says the article was not found, without querying', async (_name, run) => {
    await expect(run()).resolves.toEqual({ error: 'Article not found' });
    expectNoQuery();
  });

  it.each([
    ['this article', { id: MALFORMED, otherId: WELL_FORMED }],
    ['the other article', { id: WELL_FORMED, otherId: MALFORMED }],
  ])('linkTranslation refuses a malformed id for %s, without querying', async (_side, ids) => {
    await expect(actions.linkTranslation(INITIAL, form(ids))).resolves.toEqual({
      error: 'Article not found',
    });
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

describe('linkTranslation given one article in two spellings', () => {
  /**
   * Postgres matches either spelling to the same row; `===` did not, so the
   * self-link check passed and the agent was told the two articles were in the
   * same language instead.
   */
  it('says an article cannot be its own translation', async () => {
    await expect(
      actions.linkTranslation(
        INITIAL,
        form({ id: WELL_FORMED, otherId: WELL_FORMED.toUpperCase() }),
      ),
    ).resolves.toEqual({ error: 'An article cannot be its own translation' });
    expectNoQuery();
  });
});

describe('createFolder given a well-formed category that names nothing', () => {
  it('asks for a category rather than breaking the foreign key', async () => {
    answerNoRows();

    await expect(
      actions.createFolder(INITIAL, form({ name: 'Shipping', categoryId: WELL_FORMED })),
    ).resolves.toEqual({ error: 'Choose a category' });
    expectNoWrite();
  });
});
