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

    position: integer('position').notNull().default(0),

    sourceSystem: sourceSystemEnum('source_system').notNull().default('native'),
    externalId: text('external_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the row last changed. An INSERT takes the writer's value or the
     * default; after that the `touch_updated_at` trigger (`db/sql/001`) stamps
     * it on every UPDATE, whatever the UPDATE writes there, one that changes
     * nothing included — so a writer that may have nothing to say compares
     * before it writes (PROJECT-STATE §6.59). No reader writes this row:
     * views and votes count in `kb_article_stats`, and a new reader counter
     * goes there, not here, or every write to it moves this date (§6.51).
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
 * It replaced three columns of the same names on `kb_articles`, copied
 * across and then dropped (`plans/kb-article-stats.md`).
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
 * A picture an article shows, held in our own bucket and served by
 * `/api/kb/images/<id>` (`lib/kb/images.ts`).
 *
 * Every image the Freshdesk import brought in was hot-linked from Freshdesk's
 * attachment bucket, which goes when the account does, so `rehost_kb_images`
 * copies each one here and points the article at the copy
 * (`plans/freshdesk-disconnection.md`, PR 1). An article stores the route's
 * path and never the object key: the bucket is private, so the route hands out
 * a signed URL for the key (`signKbImageUrl` in `lib/kb/images.ts` says how
 * long one lives), and a key moving would otherwise mean rewriting every body.
 *
 * - `storage_path` is `kb/<id>.<ext>`, built from the id and the type read off
 *   the bytes, never from the remote file's name (AGENTS.md's attachment rule).
 * - `content_type` is that reading, not what the remote server said, because
 *   Storage serves the object back with it.
 * - `source_url` is the address the copy replaced, exactly as the article's
 *   `src` held it. Unique, so a second run of the job finds every copy it
 *   already made and downloads nothing; and it is the whole of the way back,
 *   since `rehost_kb_images revert=true` writes it back over the route's path.
 *   Null for an image that never lived anywhere else, which an upload in the
 *   editor will be (PR 4).
 * - `sha256` records what was stored, for an integrity check or a later
 *   upload's dedupe. Not unique: two Freshdesk URLs holding the same bytes are
 *   two rows, each with its own source, which the way back needs.
 *
 * No foreign key to an article. One picture can sit in several articles and in
 * any number of their versions, and a version restored next year must still
 * find it, so a row outlives every body that names it.
 */
export const kbImages = pgTable(
  'kb_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storagePath: text('storage_path').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    sourceUrl: text('source_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('kb_images_storage_path_idx').on(t.storagePath),
    uniqueIndex('kb_images_source_url_idx').on(t.sourceUrl),
  ],
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
