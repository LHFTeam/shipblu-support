import { asc, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { kbArticleVersions, kbArticles, kbCategories, kbFolders, kbImages } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { articleBody } from '@/lib/kb/article-write';
import { imageSources, kbImageIdOf } from '@/lib/kb/image-src';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { rehostKbImages } from './rehost-kb-images';

/**
 * The copy of the knowledge base's pictures out of Freshdesk's bucket, against
 * real Postgres: what it writes, what it leaves, and that a second run and the
 * way back both do what the header promises. Freshdesk's bucket and our
 * Storage are fakes answering `fetch`.
 */

withCleanDatabase();

const SUPABASE = 'https://project.supabase.co';
const BUCKET = 'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production';
const IMG = {
  one: `${BUCKET}/154000000001/original/one.png?1738062536`,
  two: `${BUCKET}/154000000002/original/two.png?1738062573`,
  three: `${BUCKET}/154000000003/original/three.jpg?1738062600`,
  /** Only ever in a version: the article has since dropped it. */
  old: `${BUCKET}/154000000004/original/old.png?1728982910`,
};

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]);

type Upload = { path: string; contentType: string | null };

/**
 * Freshdesk answers each address in `files` with its bytes and anything else
 * with a 404; Storage stores what it is sent, unless told to refuse.
 */
function serve(
  files: Record<string, Uint8Array<ArrayBuffer> | (() => Response | Promise<Response>)>,
  options: { storageRefuses?: boolean } = {},
) {
  const uploads: Upload[] = [];
  const removed: string[] = [];
  const asked: string[] = [];
  const mock = stubFetch(async (url, init) => {
    if (url.startsWith(`${SUPABASE}/storage/v1/object/`)) {
      if (init?.method === 'DELETE') {
        const body = JSON.parse(String(init.body)) as { prefixes: string[] };
        removed.push(...body.prefixes);
        return new Response('[]', { status: 200 });
      }
      if (options.storageRefuses) return new Response('{"error":"down"}', { status: 503 });
      const path = decodeURI(url.slice(`${SUPABASE}/storage/v1/object/attachments/`.length));
      uploads.push({ path, contentType: new Headers(init?.headers).get('content-type') });
      return new Response('{}', { status: 200 });
    }
    asked.push(url);
    const file = files[url];
    if (file === undefined) return new Response('<Error>NoSuchKey</Error>', { status: 404 });
    return typeof file === 'function' ? file() : new Response(file, { status: 200 });
  });
  return { mock, uploads, removed, asked };
}

let logs: string[] = [];

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role');
  resetEnvCache();
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

const job = (payload: Record<string, unknown> = {}) =>
  ({ id: 'job-1', type: 'rehost_kb_images', payload }) as unknown as ClaimedJob;

let folderId: string;

async function folder(): Promise<string> {
  const [category] = await db
    .insert(kbCategories)
    .values({ name: 'Orders', slug: 'orders' })
    .returning({ id: kbCategories.id });
  const [row] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: 'Orders', slug: 'orders' })
    .returning({ id: kbFolders.id });
  return row!.id;
}

/** An article stored as the write path stores it, with the pictures given. */
async function article(locale: string, slug: string, images: string[]): Promise<string> {
  const html =
    `<h2>${slug}</h2>` +
    images.map((src, i) => `<p>Step ${i + 1}</p><p><img src="${src}" /></p>`).join('');
  const body = articleBody(html);
  const [row] = await db
    .insert(kbArticles)
    .values({ folderId, title: slug, slug, locale, status: 'published', ...body })
    .returning({ id: kbArticles.id });
  return row!.id;
}

async function version(articleId: string, n: number, images: string[]): Promise<void> {
  const html = images.map((src) => `<p><img src="${src}" /></p>`).join('');
  await db
    .insert(kbArticleVersions)
    .values({ articleId, version: n, title: 'v', bodyHtml: articleBody(html).bodyHtml });
}

async function bodyOf(id: string) {
  const [row] = await db
    .select({
      bodyHtml: kbArticles.bodyHtml,
      bodyText: kbArticles.bodyText,
      updatedAt: kbArticles.updatedAt,
    })
    .from(kbArticles)
    .where(eq(kbArticles.id, id));
  return row!;
}

async function versionsOf(id: string) {
  return db
    .select({ version: kbArticleVersions.version, bodyHtml: kbArticleVersions.bodyHtml })
    .from(kbArticleVersions)
    .where(eq(kbArticleVersions.articleId, id))
    .orderBy(asc(kbArticleVersions.version));
}

async function images() {
  return db
    .select({
      id: kbImages.id,
      sourceUrl: kbImages.sourceUrl,
      storagePath: kbImages.storagePath,
      contentType: kbImages.contentType,
      sizeBytes: kbImages.sizeBytes,
    })
    .from(kbImages);
}

/** The two `images` rows of the plan's audit query, which PR 1 is verified by. */
async function audit(): Promise<{ live: number; versions: number }> {
  const pattern = '(freshdesk|freshworks|freshchat|freshservice|fwcdn|fw-cdn|fwusercontent)';
  const rows = await db.execute<{ what: string; n: number }>(sql`
    select 'live' as what, count(*)::int as n
    from kb_articles a, regexp_matches(a.body_html, '<img[^>]*src="([^"]*)"', 'gi') m
    where m[1] ~* ${pattern}
    union all
    select 'versions', count(*)::int
    from kb_article_versions v, regexp_matches(v.body_html, '<img[^>]*src="([^"]*)"', 'gi') m
    where m[1] ~* ${pattern}`);
  const n = (what: string) => rows.find((row) => row.what === what)?.n ?? -1;
  return { live: n('live'), versions: n('versions') };
}

/** Each article's own src, mapped back through `kb_images` to what it replaced. */
async function sourcesBehind(html: string): Promise<string[]> {
  const byId = new Map((await images()).map((row) => [row.id, row.sourceUrl]));
  return imageSources(html).map((src) => {
    const id = kbImageIdOf(src);
    return id ? `copy of ${byId.get(id) ?? 'nothing'}` : src;
  });
}

describe('rehost_kb_images', () => {
  let arabic: string;
  let english: string;

  beforeEach(async () => {
    folderId = await folder();
    arabic = await article('ar', 'إنشاء-أوردر', [IMG.one, IMG.two]);
    english = await article('en', 'create-order', [IMG.one, IMG.three]);
    await version(arabic, 1, [IMG.one, IMG.old]);
  });

  it('downloads nothing and writes nothing on a dry run, and counts what a real run would', async () => {
    const { mock } = serve({});
    const before = await bodyOf(arabic);

    await rehostKbImages(job({ dryRun: true }));

    expect(mock).not.toHaveBeenCalled();
    expect(await images()).toEqual([]);
    expect(await bodyOf(arabic)).toEqual(before);
    expect(await audit()).toEqual({ live: 4, versions: 2 });
    expect(logs.join('\n')).toContain('would_copy=4');
  });

  it('copies each address once and points every article and version at the copies', async () => {
    const { asked, uploads } = serve({
      [IMG.one]: PNG,
      [IMG.two]: PNG,
      [IMG.three]: JPEG,
      [IMG.old]: PNG,
    });
    const textBefore = (await bodyOf(arabic)).bodyText;

    await rehostKbImages(job());

    // One download per address, though `one` is in three bodies.
    expect(asked.sort()).toEqual(Object.values(IMG).sort());
    const rows = await images();
    expect(rows.map((row) => row.sourceUrl).sort()).toEqual(Object.values(IMG).sort());
    for (const row of rows) {
      expect(row.storagePath).toBe(`kb/${row.id}.${row.sourceUrl === IMG.three ? 'jpg' : 'png'}`);
      expect(row.contentType).toBe(row.sourceUrl === IMG.three ? 'image/jpeg' : 'image/png');
      expect(row.sizeBytes).toBe(16);
    }
    expect(uploads.map((upload) => upload.path).sort()).toEqual(
      rows.map((row) => row.storagePath).sort(),
    );

    expect(await sourcesBehind((await bodyOf(arabic)).bodyHtml)).toEqual([
      `copy of ${IMG.one}`,
      `copy of ${IMG.two}`,
    ]);
    expect(await sourcesBehind((await bodyOf(english)).bodyHtml)).toEqual([
      `copy of ${IMG.one}`,
      `copy of ${IMG.three}`,
    ]);

    // The version is rewritten where it stands, and no new one is cut: a cut
    // one would hold Freshdesk's address for a Restore to bring back, and date
    // the article as edited today on the help centre.
    const history = await versionsOf(arabic);
    expect(history.map((row) => row.version)).toEqual([1]);
    expect(await sourcesBehind(history[0]!.bodyHtml)).toEqual([
      `copy of ${IMG.one}`,
      `copy of ${IMG.old}`,
    ]);

    expect((await bodyOf(arabic)).bodyText).toBe(textBefore);
    expect(await audit()).toEqual({ live: 0, versions: 0 });
  });

  it('downloads and writes nothing the second time, and its dry run says so', async () => {
    serve({ [IMG.one]: PNG, [IMG.two]: PNG, [IMG.three]: JPEG, [IMG.old]: PNG });
    await rehostKbImages(job());
    const after = await bodyOf(arabic);

    const { mock } = serve({});
    await rehostKbImages(job());
    expect(mock).not.toHaveBeenCalled();
    // Not written at all, so `touch_updated_at` did not move it.
    expect(await bodyOf(arabic)).toEqual(after);

    logs = [];
    await rehostKbImages(job({ dryRun: true }));
    expect(logs.join('\n')).toContain('nothing to do');
  });

  it('keeps the address of every picture it could not copy, and names each one', async () => {
    const elsewhere = 'https://s3.amazonaws.com/some-other-bucket/freshdesk-export/x.png';
    await article('en', 'elsewhere', [elsewhere]);
    const { asked } = serve({
      [IMG.one]: PNG,
      [IMG.two]: () => new Response('<Error>AccessDenied</Error>', { status: 403 }),
      [IMG.three]: () => new Response('<!doctype html><title>Gone</title>', { status: 200 }),
      [IMG.old]: PNG,
    });

    await rehostKbImages(job());

    // Matched by the audit's pattern, never fetched: it is not Freshworks'.
    expect(asked).not.toContain(elsewhere);
    expect((await images()).map((row) => row.sourceUrl).sort()).toEqual([IMG.old, IMG.one].sort());
    expect(await sourcesBehind((await bodyOf(arabic)).bodyHtml)).toEqual([
      `copy of ${IMG.one}`,
      IMG.two,
    ]);
    expect(await sourcesBehind((await bodyOf(english)).bodyHtml)).toEqual([
      `copy of ${IMG.one}`,
      IMG.three,
    ]);

    const report = logs.join('\n');
    expect(report).toContain(`kept ${IMG.two}: answered 403 in=ar/إنشاء-أوردر`);
    expect(report).toContain(
      `kept ${IMG.three}: is not a PNG, JPEG, GIF or WebP image in=en/create-order`,
    );
    expect(report).toContain(`kept ${elsewhere}: not a Freshworks address`);
    expect(report).toContain('failed=3');
    expect(report).not.toContain('nothing to do');
  });

  it('keeps the address when our own storage refuses, and records no copy', async () => {
    serve(
      { [IMG.one]: PNG, [IMG.two]: PNG, [IMG.three]: JPEG, [IMG.old]: PNG },
      { storageRefuses: true },
    );
    const before = await bodyOf(arabic);

    await rehostKbImages(job());

    expect(await images()).toEqual([]);
    expect(await bodyOf(arabic)).toEqual(before);
    expect(logs.join('\n')).toContain(
      `kept ${IMG.one}: could not be stored: Storage upload failed (503)`,
    );
  });

  it('stops after three copies our side refused, and names the rest as not tried', async () => {
    const { asked, uploads } = serve(
      { [IMG.one]: PNG, [IMG.two]: PNG, [IMG.three]: JPEG, [IMG.old]: PNG },
      { storageRefuses: true },
    );

    await rehostKbImages(job());

    // Four addresses; three downloaded and refused by Storage, the fourth
    // never asked for, since the next would only have been refused too.
    expect(asked).toHaveLength(3);
    expect(uploads).toHaveLength(0);
    const report = logs.join('\n');
    expect(report).toContain('not tried: the last 3 copies could not be stored');
    expect(report).toContain('failed=4');
  });

  it('keeps going past pictures that fail on their own', async () => {
    const forbidden = () => new Response('<Error>AccessDenied</Error>', { status: 403 });
    const { asked } = serve({
      [IMG.one]: forbidden,
      [IMG.two]: forbidden,
      [IMG.three]: forbidden,
      [IMG.old]: PNG,
    });

    await rehostKbImages(job());

    // A 403 is the picture's problem, not ours: all four are asked for.
    expect(asked).toHaveLength(4);
    expect((await images()).map((row) => row.sourceUrl)).toEqual([IMG.old]);
  });
  it('leaves an article an editor saved while it ran, and says to run it again', async () => {
    const edited = articleBody('<p>Rewritten by hand while the job ran.</p>').bodyHtml;
    serve({
      [IMG.one]: async () => {
        await db.update(kbArticles).set({ bodyHtml: edited }).where(eq(kbArticles.id, arabic));
        return new Response(PNG, { status: 200 });
      },
      [IMG.two]: PNG,
      [IMG.three]: JPEG,
      [IMG.old]: PNG,
    });

    await rehostKbImages(job());

    expect((await bodyOf(arabic)).bodyHtml).toBe(edited);
    expect(await sourcesBehind((await bodyOf(english)).bodyHtml)).toEqual([
      `copy of ${IMG.one}`,
      `copy of ${IMG.three}`,
    ]);
    expect(logs.join('\n')).toContain('skipped ar/إنشاء-أوردر: it changed while the job ran');
  });

  it('narrows to one locale and a number of articles, versions with them', async () => {
    const { asked } = serve({ [IMG.one]: PNG, [IMG.two]: PNG, [IMG.three]: JPEG, [IMG.old]: PNG });
    const arabicBefore = await bodyOf(arabic);

    await rehostKbImages(job({ locale: 'en' }));

    expect(asked.sort()).toEqual([IMG.one, IMG.three].sort());
    expect(await bodyOf(arabic)).toEqual(arabicBefore);
    expect(await audit()).toEqual({ live: 2, versions: 2 });

    await rehostKbImages(job({ locale: 'ar', limit: 1 }));
    expect(await audit()).toEqual({ live: 0, versions: 0 });
  });

  it('puts every address back on the way back, and nothing on its dry run', async () => {
    serve({ [IMG.one]: PNG, [IMG.two]: PNG, [IMG.three]: JPEG, [IMG.old]: PNG });
    const original = {
      arabic: (await bodyOf(arabic)).bodyHtml,
      english: (await bodyOf(english)).bodyHtml,
      version: (await versionsOf(arabic))[0]!.bodyHtml,
    };
    await rehostKbImages(job());
    const copied = (await bodyOf(arabic)).bodyHtml;

    await rehostKbImages(job({ revert: true, dryRun: true }));
    expect((await bodyOf(arabic)).bodyHtml).toBe(copied);

    await rehostKbImages(job({ revert: true }));
    expect((await bodyOf(arabic)).bodyHtml).toBe(original.arabic);
    expect((await bodyOf(english)).bodyHtml).toBe(original.english);
    expect((await versionsOf(arabic))[0]!.bodyHtml).toBe(original.version);
    // The copies stay, so running forward again downloads nothing.
    expect(await images()).toHaveLength(4);
  });
  it('does not call a way back that leaves a picture on our route "nothing to do"', async () => {
    // A picture recorded with no source, as an editor's upload will be: the
    // way back has nowhere to send it, and a build without the route would
    // show it broken, so the dry run must not read as clean.
    const id = crypto.randomUUID();
    await db.insert(kbImages).values({
      id,
      storagePath: `kb/${id}.png`,
      contentType: 'image/png',
      sizeBytes: 16,
      sha256: 'b'.repeat(64),
      sourceUrl: null,
    });
    await db
      .update(kbArticles)
      .set({ bodyHtml: articleBody(`<p><img src="/api/kb/images/${id}" /></p>`).bodyHtml })
      .where(eq(kbArticles.id, english));
    serve({});

    await rehostKbImages(job({ revert: true, dryRun: true }));

    const report = logs.join('\n');
    expect(report).toContain('left_without_source=1');
    expect(report).not.toContain('nothing to do');
  });
});
