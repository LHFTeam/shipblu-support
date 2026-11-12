import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  kbArticleVersions,
  kbArticles,
  kbCategories,
  kbFolders,
  kbImages,
} from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { articleBody } from '@/lib/kb/article-write';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';

/**
 * Restoring an article version writes every column the body feeds. The
 * restore used to set the body and its search text but not the excerpt, so a
 * listing kept showing the opening line of the body it had just replaced.
 *
 * And a Save with nothing edited writes nothing: `touch_updated_at` stamps every
 * UPDATE, one that changes nothing included, so a written no-op would float the
 * article to the top of `/kb`. Read off `xmin`, which any write moves.
 */

const signedIn = vi.hoisted(() => ({ id: '' }));

vi.mock('@/lib/auth/guard', () => ({
  requirePermission: async () => ({ id: signedIn.id, role: 'admin' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

/**
 * Who the picture upload finds signed in. It asks the session itself rather
 * than through the guard, because a redirect from an action the editor calls
 * directly would take the unsaved draft with the page.
 */
const session = vi.hoisted(() => ({
  agent: { id: 'agent-1', role: 'admin', permissions: {} } as {
    id: string;
    role: string;
    permissions: Record<string, boolean>;
  } | null,
}));
vi.mock('@/lib/auth/session', async (original) => ({
  ...(await original<typeof import('@/lib/auth/session')>()),
  getSessionAgent: async () => session.agent,
}));

const { restoreVersion, saveArticle, uploadArticlePicture } = await import('./actions');

withCleanDatabase();

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function article(bodyHtml: string, excerpt: string) {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test', role: 'admin' })
    .returning({ id: agents.id });
  signedIn.id = agent!.id;

  const [category] = await db
    .insert(kbCategories)
    .values({ name: 'Shipping', slug: 'shipping' })
    .returning({ id: kbCategories.id });
  const [folder] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: 'Delivery', slug: 'delivery' })
    .returning({ id: kbFolders.id });
  const [row] = await db
    .insert(kbArticles)
    .values({
      folderId: folder!.id,
      title: 'Current title',
      slug: 'current',
      bodyHtml,
      bodyText: 'Current body text.',
      excerpt,
    })
    .returning({ id: kbArticles.id });
  return row!.id;
}

describe('restoreVersion', () => {
  it('rebuilds the excerpt from the restored body', async () => {
    const id = await article('<p>Current body text.</p>', 'Current body text.');
    const [version] = await db
      .insert(kbArticleVersions)
      .values({
        articleId: id,
        version: 1,
        title: 'Old title',
        bodyHtml: '<p>The body this article had before.</p>',
      })
      .returning({ id: kbArticleVersions.id });

    const state = await restoreVersion({ error: null }, form({ id, versionId: version!.id }));
    expect(state.error).toBeNull();

    const [restored] = await db
      .select({
        title: kbArticles.title,
        bodyText: kbArticles.bodyText,
        excerpt: kbArticles.excerpt,
      })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));

    expect(restored).toEqual({
      title: 'Old title',
      bodyText: 'The body this article had before.',
      excerpt: 'The body this article had before.',
    });
  });
});

describe('saveArticle', () => {
  /** The editor's form for the article as the fixture writes it. */
  async function editorForm(id: string, overrides: Record<string, string> = {}) {
    const [row] = await db
      .select({ folderId: kbArticles.folderId })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    return form({
      id,
      title: 'Current title',
      folderId: row!.folderId,
      locale: 'en',
      bodyHtml: '<p>Current body text.</p>',
      visibility: 'public',
      slug: 'current',
      seoTitle: '',
      seoDescription: '',
      tags: 'pickup, courier',
      ...overrides,
    });
  }

  async function written(id: string) {
    const [row] = await db
      .select({ xmin: sql<string>`xmin::text`, updatedAt: kbArticles.updatedAt })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    return row!;
  }

  it('writes nothing when nothing was edited, and answers a success', async () => {
    const id = await article('<p>Current body text.</p>', 'Current body text.');
    // The first save writes what the form holds that the fixture did not, the
    // tags among them; the second finds the row as the form says.
    expect((await saveArticle({ error: null }, await editorForm(id))).error).toBeNull();
    const before = await written(id);

    const state = await saveArticle({ error: null }, await editorForm(id));

    expect(state.error).toBeNull();
    expect(await written(id)).toEqual(before);
  });

  // A browser posts a textarea with CRLF line breaks whatever it holds, and the
  // handbook, the import and the formatting pass store LF.
  it('writes nothing when the body comes back with CRLF where it is stored with LF', async () => {
    const id = await article('<p>Current body text.</p>', 'Current body text.');
    const twoLines = '<p>Current body text.</p>\n<p>A second line.</p>';
    await saveArticle({ error: null }, await editorForm(id, { bodyHtml: twoLines }));
    const before = await written(id);
    const versions = await db
      .select({ id: kbArticleVersions.id })
      .from(kbArticleVersions)
      .where(eq(kbArticleVersions.articleId, id));

    await saveArticle(
      { error: null },
      await editorForm(id, { bodyHtml: twoLines.replace(/\n/g, '\r\n') }),
    );

    expect(await written(id)).toEqual(before);
    expect(
      await db
        .select({ id: kbArticleVersions.id })
        .from(kbArticleVersions)
        .where(eq(kbArticleVersions.articleId, id)),
    ).toEqual(versions);
  });

  it('writes the row when one field differs', async () => {
    const id = await article('<p>Current body text.</p>', 'Current body text.');
    await saveArticle({ error: null }, await editorForm(id));
    const before = await written(id);

    await saveArticle({ error: null }, await editorForm(id, { tags: 'pickup' }));

    expect((await written(id)).xmin).not.toBe(before.xmin);
    const [row] = await db
      .select({ tags: kbArticles.tags })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    expect(row!.tags).toEqual(['pickup']);
  });
});

/**
 * A picture `rehost_kb_images` has copied goes back in as the copy, whatever
 * the body arriving names: an editor tab opened before the job ran posts
 * Freshdesk's address, and so does a version cut before it.
 */
describe('a Freshdesk picture already copied', () => {
  const FRESHDESK =
    'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/1/original/a.png?1738062536';
  const UNCOPIED =
    'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/2/original/b.png?1738062573';

  async function copied(): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(kbImages).values({
      id,
      storagePath: `kb/${id}.png`,
      contentType: 'image/png',
      sizeBytes: 16,
      sha256: 'c'.repeat(64),
      sourceUrl: FRESHDESK,
    });
    return id;
  }

  const showing = (...srcs: string[]) =>
    articleBody(srcs.map((src) => `<p><img src="${src}" /></p>`).join('')).bodyHtml;

  async function bodyOf(id: string) {
    const [row] = await db
      .select({ bodyHtml: kbArticles.bodyHtml })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    return row!.bodyHtml;
  }

  it("is saved as the copy when a stale editor posts Freshdesk's address", async () => {
    const image = await copied();
    // Beside a picture the job could not copy, which the article already
    // shows, so the save adds nothing of Freshdesk's and it stays for the job.
    const id = await article(showing(`/api/kb/images/${image}`, UNCOPIED), '');
    const [row] = await db
      .select({ folderId: kbArticles.folderId })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));

    const state = await saveArticle(
      { error: null },
      form({
        id,
        title: 'Current title',
        folderId: row!.folderId,
        locale: 'en',
        // What the tab opened before the job still holds.
        bodyHtml: `<p><img src="${FRESHDESK}" /></p><p><img src="${UNCOPIED}" /></p>`,
        visibility: 'public',
        slug: 'current',
        seoTitle: '',
        seoDescription: '',
        tags: '',
      }),
    );

    expect(state.error).toBeNull();
    expect(await bodyOf(id)).toBe(showing(`/api/kb/images/${image}`, UNCOPIED));
  });

  it('is restored as the copy from a version that names Freshdesk', async () => {
    const image = await copied();
    const id = await article(showing(`/api/kb/images/${image}`), '');
    const [version] = await db
      .insert(kbArticleVersions)
      .values({ articleId: id, version: 1, title: 'Old title', bodyHtml: showing(FRESHDESK) })
      .returning({ id: kbArticleVersions.id });

    const state = await restoreVersion({ error: null }, form({ id, versionId: version!.id }));

    expect(state.error).toBeNull();
    expect(await bodyOf(id)).toBe(showing(`/api/kb/images/${image}`));
  });
});

/**
 * PR 2 of `plans/freshdesk-disconnection.md`: neither Save nor Restore can put
 * a Freshdesk address on the help centre that the article did not carry.
 * What has a home here is pointed at it; what has none is refused, and
 * nothing reaches `kb_articles`.
 */
describe("Freshdesk's links and pictures", () => {
  const PICTURE =
    'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/3/original/c.png';
  /** As 18 production versions carry them, to an article that was imported. */
  const PORTAL = (id: string, locale = 'en') =>
    `https://support.shipblu.com/${locale}/support/solutions/articles/${id}-packaging-guidelines`;
  const CONSOLE = (id: string) =>
    `https://shipblu72137318794432249.freshdesk.com/a/solutions/articles/${id}?lang=ar&amp;portalId=154000090201`;

  /** The imported article Freshdesk id 154000189336 became, in both languages. */
  async function imported(
    folderId: string,
    status: 'published' | 'draft' | 'archived' = 'published',
  ) {
    await db.insert(kbArticles).values([
      {
        folderId,
        title: 'Packaging guidelines',
        slug: 'packaging-guidelines',
        locale: 'en',
        sourceSystem: 'freshdesk',
        externalId: '154000189336:en',
        bodyHtml: '<p>Pack it well.</p>',
        status,
      },
      {
        folderId,
        title: 'إرشادات التعبئة والتغليف',
        slug: 'إرشادات-التعبئة-والتغليف',
        locale: 'ar',
        sourceSystem: 'freshdesk',
        externalId: '154000189336:ar',
        bodyHtml: '<p>غلّفها جيدا.</p>',
        status,
      },
    ]);
  }

  async function stored(id: string) {
    const [row] = await db
      .select({ bodyHtml: kbArticles.bodyHtml, folderId: kbArticles.folderId })
      .from(kbArticles)
      .where(eq(kbArticles.id, id));
    return row!;
  }

  const versions = async (id: string) =>
    db.$count(kbArticleVersions, eq(kbArticleVersions.articleId, id));

  const saving = (id: string, folderId: string, bodyHtml: string) =>
    saveArticle(
      { error: null },
      form({
        id,
        title: 'Current title',
        folderId,
        locale: 'en',
        bodyHtml,
        visibility: 'public',
        slug: 'current',
        seoTitle: '',
        seoDescription: '',
        tags: '',
      }),
    );

  it('refuses a save that adds a Freshdesk link or picture, and writes nothing', async () => {
    const before = articleBody('<p>Step one.</p>').bodyHtml;
    const id = await article(before, '');
    const { folderId } = await stored(id);

    const linked = await saving(
      id,
      folderId,
      '<p>Step one.</p><p><a href="https://support.shipblu.com/support/tickets/new">Ask us</a></p>',
    );
    const pictured = await saving(id, folderId, `<p>Step one.</p><p><img src="${PICTURE}" /></p>`);

    // A page of the portal, on a hostname that has been this app since
    // 2026-11-11: refused, and offered the stand-in proxy.ts sends it to.
    expect(linked.error).toContain(
      "a link to a page of Freshdesk's old portal, which now only redirects to /ar#contact here",
    );
    expect(pictured.error).toContain('a picture from Freshdesk');
    expect(await stored(id)).toMatchObject({ bodyHtml: before });
    expect(await versions(id)).toBe(0);
  });

  it('refuses a new article that links to an article Freshdesk never handed over', async () => {
    const id = await article('<p>Existing.</p>', '');
    const { folderId } = await stored(id);

    const state = await saveArticle(
      { error: null },
      form({
        title: 'Brand new',
        folderId,
        locale: 'en',
        bodyHtml: `<p><a href="${PORTAL('154000000001')}">See</a></p>`,
        visibility: 'public',
      }),
    );

    expect(state.error).toContain(
      'Freshdesk article 154000000001, which has no published article here',
    );
    expect(await db.$count(kbArticles)).toBe(1);
  });

  it('saves a link to an imported Freshdesk article as that article', async () => {
    const id = await article('<p>Step one.</p>', '');
    const { folderId } = await stored(id);
    await imported(folderId);

    const state = await saving(
      id,
      folderId,
      `<p>See <a href="${PORTAL('154000189336')}">this</a></p>`,
    );

    expect(state.error).toBeNull();
    expect((await stored(id)).bodyHtml).toBe(
      articleBody('<p>See <a href="/en/a/packaging-guidelines">this</a></p>').bodyHtml,
    );
  });

  // Pointed at a draft, the link would 404 for every reader and no longer look
  // like Freshdesk's, so nothing would refuse it.
  it('refuses a link to an imported article no reader can open, rather than pointing it there', async () => {
    const id = await article('<p>Step one.</p>', '');
    const { folderId } = await stored(id);
    await imported(folderId, 'draft');
    const before = (await stored(id)).bodyHtml;

    const state = await saving(
      id,
      folderId,
      `<p>See <a href="${PORTAL('154000189336')}">this</a></p>`,
    );

    expect(state.error).toContain(
      'Freshdesk article 154000189336, which has no published article here',
    );
    expect((await stored(id)).bodyHtml).toBe(before);
  });

  it("restores a version's Freshdesk links as the articles they were imported as", async () => {
    const id = await article('<p>Now.</p>', '');
    const { folderId } = await stored(id);
    await imported(folderId);
    const [version] = await db
      .insert(kbArticleVersions)
      .values({
        articleId: id,
        version: 1,
        title: 'Old title',
        bodyHtml:
          `<p><a href="${PORTAL('154000189336', 'ar')}">إرشادات</a></p>` +
          `<p><a href="${CONSOLE('154000189336')}">الجدول</a></p>`,
      })
      .returning({ id: kbArticleVersions.id });

    const state = await restoreVersion({ error: null }, form({ id, versionId: version!.id }));

    expect(state.error).toBeNull();
    expect((await stored(id)).bodyHtml).toBe(
      articleBody(
        '<p><a href="/ar/a/إرشادات-التعبئة-والتغليف">إرشادات</a></p>' +
          '<p><a href="/ar/a/إرشادات-التعبئة-والتغليف">الجدول</a></p>',
      ).bodyHtml,
    );
  });

  it('refuses to restore a version naming Freshdesk where nothing here replaces it', async () => {
    const now = articleBody('<p>Now.</p>').bodyHtml;
    const id = await article(now, '');
    const [version] = await db
      .insert(kbArticleVersions)
      .values({
        articleId: id,
        version: 1,
        title: 'Old title',
        bodyHtml: `<p><a href="${PORTAL('154000000001')}">Gone</a></p>`,
      })
      .returning({ id: kbArticleVersions.id });

    const state = await restoreVersion({ error: null }, form({ id, versionId: version!.id }));

    expect(state.error).toMatch(/^That version has a link to Freshdesk article 154000000001/);
    expect(await stored(id)).toMatchObject({ bodyHtml: now });
    // Refused before anything is written: no version is cut for a restore
    // that did not happen.
    expect(await versions(id)).toBe(1);
  });
});

/**
 * PR 4 of `plans/freshdesk-disconnection.md`: the editor's picture upload,
 * against real Postgres with Storage faked. What is stored is judged by its
 * bytes and served from the image route, and nothing else is written.
 */
describe('uploadArticlePicture', () => {
  const SUPABASE = 'https://project.supabase.co';
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
  ]);

  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', SUPABASE);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role');
    resetEnvCache();
    session.agent = { id: 'agent-1', role: 'admin', permissions: {} };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetEnvCache();
  });

  /** Storage, recording what it was sent; refusing when told to. */
  function storage(refuses = false) {
    const uploads: { path: string; contentType: string | null }[] = [];
    stubFetch((url, init) => {
      if (refuses) return new Response('{"error":"down"}', { status: 503 });
      uploads.push({
        path: url.slice(`${SUPABASE}/storage/v1/object/attachments/`.length),
        contentType: new Headers(init?.headers).get('content-type'),
      });
      return new Response('{}', { status: 200 });
    });
    return uploads;
  }

  const upload = (bytes: Uint8Array<ArrayBuffer>, name: string, type: string) => {
    const data = new FormData();
    data.set('picture', new File([bytes], name, { type }));
    return uploadArticlePicture(data);
  };

  it('stores a picture as its bytes say and answers the route that serves it', async () => {
    const uploads = storage();

    // Labelled JPEG by the browser; the bytes are a PNG, and that is what is kept.
    const answer = await upload(PNG, 'screenshot.jpg', 'image/jpeg');

    const [row] = await db.select().from(kbImages);
    expect(answer).toMatchObject({ error: null, src: `/api/kb/images/${row!.id}` });
    expect(row).toMatchObject({
      storagePath: `kb/${row!.id}.png`,
      contentType: 'image/png',
      sourceUrl: null,
    });
    expect(uploads).toEqual([{ path: `kb/${row!.id}.png`, contentType: 'image/png' }]);
  });

  it('refuses what is not a picture an article may show, and stores nothing', async () => {
    const uploads = storage();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    expect(await upload(svg, 'logo.svg', 'image/png')).toEqual({
      error: 'Only a PNG, JPEG, GIF or WebP picture can go in an article.',
    });
    expect(await upload(new Uint8Array(0), 'empty.png', 'image/png')).toEqual({
      error: 'That file is empty. Choose a picture to upload.',
    });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(await upload(big, 'huge.png', 'image/png')).toEqual({
      error: 'That picture is over 10 MB, the most a picture can be.',
    });

    expect(uploads).toEqual([]);
    expect(await db.$count(kbImages)).toBe(0);
  });

  it('refuses a request carrying no file, and one carrying text in its place', async () => {
    const uploads = storage();
    const asText = new FormData();
    asText.set('picture', 'not a file');

    expect(await uploadArticlePicture(new FormData())).toEqual({
      error: 'Choose a picture to upload.',
    });
    expect(await uploadArticlePicture(asText)).toEqual({ error: 'Choose a picture to upload.' });
    expect(uploads).toEqual([]);
  });

  // Answered in words, not redirected: the editor calls this directly, and a
  // followed redirect would take the unsaved draft with the page.
  it('stores nothing for somebody signed out or without kb.edit, and says why', async () => {
    const uploads = storage();

    session.agent = null;
    expect((await upload(PNG, 'step.png', 'image/png')).error).toMatch(/^You have been signed out/);
    session.agent = { id: 'agent-2', role: 'agent', permissions: {} };
    expect(await upload(PNG, 'step.png', 'image/png')).toEqual({
      error: 'You can no longer edit the knowledge base, so the picture was not added.',
    });
    session.agent = { id: 'agent-3', role: 'admin', permissions: { 'kb.edit': false } };
    expect((await upload(PNG, 'step.png', 'image/png')).error).toMatch(/no longer edit/);

    expect(uploads).toEqual([]);
    expect(await db.$count(kbImages)).toBe(0);
  });

  it('says so when Storage refuses, and records no row', async () => {
    storage(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await upload(PNG, 'step.png', 'image/png')).toEqual({
      error: 'The picture could not be stored. Try again in a moment.',
    });
    expect(await db.$count(kbImages)).toBe(0);
  });
});
