import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * The names `touch_updated_at()` excludes from an article's edit comparison
 * have to be columns of `kb_articles`, and every reader counter and generated
 * column has to be among them (PROJECT-STATE §6.51).
 */

const sql = (...names) =>
  `CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  not_an_edit constant text[] := ARRAY[
    ${names.map((name) => `'${name}'`).join(', ')}
  ];
BEGIN
  RETURN NEW;
END;
$$;
`;

const schema = (...extra) =>
  `export const kbArticles = pgTable(
  'kb_articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    seo: jsonb('seo').$type<{ title?: string }>().notNull().default({}),
    viewCount: integer('view_count').notNull().default(0),
    helpfulCount: integer('helpful_count').notNull().default(0),
    position: integer('position').notNull().default(0),
${extra.join('\n')}
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql\`to_tsvector('simple', coalesce(title, ''))\`,
    ),
  },
  (t) => [index('kb_articles_search_idx').using('gin', t.searchVector)],
);

export const kbArticleVersions = pgTable('kb_article_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  hitCount: integer('hit_count').notNull().default(0),
});
`;

const LISTED = ['updated_at', 'search_vector', 'view_count', 'helpful_count'];

const run = ({ names = LISTED, extra = [] } = {}) =>
  runRule('kb-edit-date', {
    'db/sql/001_extensions_and_triggers.sql': sql(...names),
    'db/schema/kb.ts': schema(...extra),
  });

describe('kb-edit-date', () => {
  it('passes when the list and the table agree', async () => {
    // `position` is an integer people edit, and `hit_count` is another table's.
    expect(await run()).toEqual([]);
  });

  it('refuses a listed name that is not a column', async () => {
    const found = await run({ names: [...LISTED.filter((n) => n !== 'view_count'), 'views'] });

    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: 'db/sql/001_extensions_and_triggers.sql',
          message: expect.stringContaining('"views"'),
        }),
        expect.objectContaining({
          where: 'db/schema/kb.ts',
          message: expect.stringContaining('kb_articles.view_count looks like a counter'),
        }),
      ]),
    );
    expect(found).toHaveLength(2);
  });

  it('refuses a new counter the list does not name', async () => {
    const found = await run({
      extra: ["    shareCount: integer('share_count').notNull().default(0),"],
    });

    expect(found).toEqual([
      expect.objectContaining({
        rule: 'kb-edit-date',
        where: 'db/schema/kb.ts',
        message: expect.stringContaining('kb_articles.share_count'),
      }),
    ]);
  });

  it('refuses a generated column the list does not name', async () => {
    const found = await run({ names: LISTED.filter((n) => n !== 'search_vector') });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'db/schema/kb.ts',
        message: expect.stringContaining('kb_articles.search_vector is a generated column'),
      }),
    ]);
  });

  it('says so when it cannot read the list', async () => {
    const found = await runRule('kb-edit-date', {
      'db/sql/001_extensions_and_triggers.sql': 'CREATE OR REPLACE FUNCTION touch_updated_at();\n',
      'db/schema/kb.ts': schema(),
    });

    expect(found).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('no longer declares not_an_edit'),
      }),
    ]);
  });
});
