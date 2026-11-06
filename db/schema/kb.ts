import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { agentRoleEnum, kbArticleStatusEnum, kbVisibilityEnum, sourceSystemEnum } from './enums';
import { tsvector } from './conversations';

/**
 * Knowledge base, mirroring Freshdesk's category → folder → article hierarchy so
 * imported content keeps its shape and existing URLs stay meaningful.
 *
 * `locale` exists from the first migration rather than being added later:
 * ShipBlu needs English and Arabic, and retrofitting translations onto a
 * single-language schema means rewriting every KB query and URL.
 */

export const kbCategories = pgTable(
  'kb_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    locale: text('locale').notNull().default('en'),
    position: integer('position').notNull().default(0),

    /** Groups translations of the same category together. */
    translationGroupId: uuid('translation_group_id').notNull().defaultRandom(),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('kb_categories_slug_locale_idx').on(t.slug, t.locale),
    uniqueIndex('kb_categories_external_idx').on(t.sourceSystem, t.externalId),
  ],
);

export const kbFolders = pgTable(
  'kb_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => kbCategories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    position: integer('position').notNull().default(0),

    visibility: kbVisibilityEnum('visibility').notNull().default('public'),
    /** Used when visibility = 'selected_companies'. */
    visibleToCompanyIds: uuid('visible_to_company_ids').array().notNull().default([]),

    /**
     * The lowest role on the team that may read what is inside, or null for no
     * floor. Read only where the folder is internal — see `lib/kb/internal.ts`.
     */
    minRole: agentRoleEnum('min_role'),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('kb_folders_category_slug_idx').on(t.categoryId, t.slug),
    uniqueIndex('kb_folders_external_idx').on(t.sourceSystem, t.externalId),
  ],
);

export const kbArticles = pgTable(
  'kb_articles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => kbFolders.id, { onDelete: 'cascade' }),

    title: text('title').notNull(),
    slug: text('slug').notNull(),
    bodyHtml: text('body_html').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    excerpt: text('excerpt'),

    locale: text('locale').notNull().default('en'),
    translationGroupId: uuid('translation_group_id').notNull().defaultRandom(),

    status: kbArticleStatusEnum('status').notNull().default('draft'),
    visibility: kbVisibilityEnum('visibility').notNull().default('public'),
    visibleToCompanyIds: uuid('visible_to_company_ids').array().notNull().default([]),

    /**
     * The lowest role on the team that may read this article, or null for no
     * floor.
     *
     * Nullable rather than defaulted to `agent` so the column arrives meaning
     * exactly what every existing row already meant — no floor — instead of
     * asserting a floor onto 112 imported articles that nobody chose. It is a
     * second axis, not a fifth `kb_visibility` level: visibility answers "may a
     * customer read this", this answers "which of us may", and folding the two
     * together would put a role branch inside the rule that keeps internal
     * runbooks out of Google.
     */
    minRole: agentRoleEnum('min_role'),

    authorAgentId: uuid('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    approvedByAgentId: uuid('approved_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    tags: text('tags').array().notNull().default([]),
    seo: jsonb('seo').$type<{ title?: string; description?: string }>().notNull().default({}),

    /**
     * Superseded by `kb_article_stats`, and still here on purpose: nothing
     * reads these three or counts into them any more, and they are dropped
     * once every service runs code that does not (`plans/kb-article-stats.md`,
     * PR 2). An INSERT still names them, as drizzle names every column, with
     * `default`; the plan says what that costs the drop.
     *
     * Not in the same release, because migrations run in `preDeployCommand`
     * while the old web release still serves, and the worker deploys by hand
     * after it: dropping them there would fail every view, vote and Freshdesk
     * import the old code still makes until the last service was redeployed.
     * Reading one now gets a count frozen at the move.
     */
    viewCount: integer('view_count').notNull().default(0),
    helpfulCount: integer('helpful_count').notNull().default(0),
    unhelpfulCount: integer('unhelpful_count').notNull().default(0),

    position: integer('position').notNull().default(0),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the row last changed. An INSERT takes the writer's value or the
     * default; after that the `touch_updated_at` trigger (`db/sql/001`) sets it
     * on every UPDATE, whatever the UPDATE writes there. An UPDATE that changes
     * nothing, or nothing but the three superseded counters above, keeps it,
     * and any other change stamps it (PROJECT-STATE §6.51). A view or a
     * feedback tap no longer writes this row at all: readers count in
     * `kb_article_stats`, and a new reader counter goes there, not here. The
     * counters' half of the exception is for the old release, which still
     * writes them during a deploy, and goes when they do.
     */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body_text, ''))`,
    ),
  },
  (t) => [
    uniqueIndex('kb_articles_slug_locale_idx').on(t.slug, t.locale),
    uniqueIndex('kb_articles_external_idx').on(t.sourceSystem, t.externalId),
    index('kb_articles_folder_idx').on(t.folderId, t.position),
    index('kb_articles_status_idx').on(t.status, t.visibility),
    index('kb_articles_search_idx').using('gin', t.searchVector),
  ],
);

/**
 * What readers do to an article: how often it was opened, and how often a
 * reader said it helped or did not.
 *
 * A table of its own rather than three columns on `kb_articles`, because
 * readers write these and only editors should write the article. On the
 * article row every view rewrote the whole row — its stored `search_vector`
 * regenerated from the title and the body each time — and held the row lock a
 * console save waits on, and the date the console sorts by followed readers
 * until `touch_updated_at` was taught an exception for it (PROJECT-STATE
 * §6.51). Here a view rewrites one narrow row that no console edit writes or
 * locks.
 *
 * No console write creates a row. A view or a vote creates it if it is the
 * first, and the Freshdesk import writes one for each article it brings in,
 * zeros included, so an article nobody has opened or rated usually has none,
 * and every reader reads a missing row as zero (`lib/kb/stats.ts`). There is
 * deliberately no `updated_at`, so the `touch_updated_at` loop in `db/sql/001`
 * attaches no trigger: this is a counter, not content, and a trigger here
 * would only add work to the hottest write the knowledge base has.
 *
 * The three columns of the same names on `kb_articles` are what this replaced
 * (`plans/kb-article-stats.md`).
 */
export const kbArticleStats = pgTable('kb_article_stats', {
  articleId: uuid('article_id')
    .primaryKey()
    .references(() => kbArticles.id, { onDelete: 'cascade' }),
  viewCount: integer('view_count').notNull().default(0),
  helpfulCount: integer('helpful_count').notNull().default(0),
  unhelpfulCount: integer('unhelpful_count').notNull().default(0),
});

export const kbArticleVersions = pgTable(
  'kb_article_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => kbArticles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    bodyHtml: text('body_html').notNull(),
    editedByAgentId: uuid('edited_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('kb_article_versions_article_version_idx').on(t.articleId, t.version)],
);

/**
 * Preserves inbound links to the existing support.shipblu.com articles at
 * migration time, so no customer bookmark or search result 404s after cutover.
 */
export const kbRedirects = pgTable(
  'kb_redirects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromPath: text('from_path').notNull(),
    articleId: uuid('article_id').references(() => kbArticles.id, { onDelete: 'cascade' }),
    toPath: text('to_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('kb_redirects_from_idx').on(t.fromPath)],
);

export const kbArticleFeedback = pgTable(
  'kb_article_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => kbArticles.id, { onDelete: 'cascade' }),
    wasHelpful: boolean('was_helpful').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('kb_article_feedback_article_idx').on(t.articleId)],
);
