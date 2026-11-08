import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { kbArticles, kbCategories, kbFolders, kbImages } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { kbImageSrc } from '@/lib/kb/image-src';
import type { KbViewer } from '@/lib/kb/visibility';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';

/**
 * The route every article's picture loads through, against real Postgres with
 * Storage's signing endpoint faked: who gets which picture, how long the
 * signature lives, what may be cached, and that a public picture asked for
 * again costs no query and no signature.
 *
 * The console's session and the help centre's reader are stood in for, since
 * they read cookies; which articles a reader may see is the real query.
 */

const reader = vi.hoisted(() => ({
  agent: false,
  viewer: { kind: 'anonymous' } as KbViewer,
}));

vi.mock('@/lib/auth/session', () => ({
  getSessionAgent: async () => (reader.agent ? { id: 'agent-1' } : null),
}));
vi.mock('@/lib/kb/viewer', () => ({ kbViewer: async () => reader.viewer }));

const { GET } = await import('./route');

withCleanDatabase();

const SUPABASE = 'https://project.supabase.co';

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role');
  resetEnvCache();
  reader.agent = false;
  reader.viewer = { kind: 'anonymous' };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvCache();
});

/** Storage's signing endpoint, recording the lifetime each signature asked for. */
function signs(answer?: () => Response) {
  const lifetimes: number[] = [];
  const mock = stubFetch((url, init) => {
    lifetimes.push((JSON.parse(String(init?.body)) as { expiresIn: number }).expiresIn);
    if (answer) return answer();
    const path = url.slice(`${SUPABASE}/storage/v1/object/sign/attachments/`.length);
    return new Response(
      JSON.stringify({ signedURL: `/object/sign/attachments/${path}?token=t-${path}` }),
      { status: 200 },
    );
  });
  return { mock, lifetimes };
}

let ip = 0;
const get = (id: string) =>
  GET(
    new Request(`http://localhost/api/kb/images/${id}`, {
      // A fresh address each time, so the route's rate limit plays no part.
      headers: { 'x-forwarded-for': `203.0.113.${(ip = (ip + 1) % 250)}` },
    }),
    { params: Promise.resolve({ id }) },
  );

async function picture(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(kbImages).values({
    id,
    storagePath: `kb/${id}.png`,
    contentType: 'image/png',
    sizeBytes: 16,
    sha256: 'a'.repeat(64),
    sourceUrl: `https://s3.amazonaws.com/cdn.freshdesk.com/${id}.png`,
  });
  return id;
}

/** An article showing `image`, in a folder of the visibility given. */
async function articleShowing(
  image: string,
  options: {
    folder?: 'public' | 'agents_only';
    article?: 'public' | 'logged_in';
    status?: 'published' | 'draft';
  } = {},
) {
  const slug = crypto.randomUUID();
  const [category] = await db
    .insert(kbCategories)
    .values({ name: slug, slug })
    .returning({ id: kbCategories.id });
  const [folder] = await db
    .insert(kbFolders)
    .values({ categoryId: category!.id, name: slug, slug, visibility: options.folder ?? 'public' })
    .returning({ id: kbFolders.id });
  await db.insert(kbArticles).values({
    folderId: folder!.id,
    title: slug,
    slug,
    status: options.status ?? 'published',
    visibility: options.article ?? 'public',
    bodyHtml: `<p>Step one</p><p><img src="${kbImageSrc(image)}" loading="lazy" /></p>`,
  });
}

describe('GET /api/kb/images/[id]', () => {
  describe('a picture a public article shows', () => {
    it('redirects anybody to a signed URL, cacheable by anybody for an hour', async () => {
      const { lifetimes } = signs();
      const id = await picture();
      await articleShowing(id);

      const response = await get(id);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        `${SUPABASE}/storage/v1/object/sign/attachments/kb/${id}.png?token=t-kb/${id}.png`,
      );
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(lifetimes).toEqual([24 * 60 * 60]);
    });

    it('signs once and hands every later reader the same URL', async () => {
      const { mock } = signs();
      const id = await picture();
      await articleShowing(id);

      const first = await get(id);
      const second = await get(id);

      expect(mock).toHaveBeenCalledTimes(1);
      expect(second.headers.get('location')).toBe(first.headers.get('location'));
    });

    it('reads an id written in capitals as the same picture', async () => {
      signs();
      const id = await picture();
      await articleShowing(id);
      expect((await get(id.toUpperCase())).status).toBe(307);
    });
  });

  describe('a picture no stranger may see', () => {
    it('is not found for a stranger when only an internal article shows it', async () => {
      const { mock } = signs();
      const id = await picture();
      await articleShowing(id, { folder: 'agents_only' });

      const response = await get(id);

      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(mock).not.toHaveBeenCalled();
    });

    it('goes to a console agent with a short signature that only their browser keeps', async () => {
      const { lifetimes } = signs();
      const id = await picture();
      await articleShowing(id, { folder: 'agents_only' });
      reader.agent = true;

      const response = await get(id);

      expect(response.status).toBe(307);
      expect(response.headers.get('cache-control')).toBe('private, max-age=240');
      expect(lifetimes).toEqual([5 * 60]);
    });

    it('is never remembered for the next reader', async () => {
      signs();
      const id = await picture();
      await articleShowing(id, { folder: 'agents_only' });
      reader.agent = true;
      expect((await get(id)).status).toBe(307);

      reader.agent = false;
      expect((await get(id)).status).toBe(404);
    });

    it('goes to a signed-in customer an article visible to them shows it to', async () => {
      signs();
      const id = await picture();
      await articleShowing(id, { article: 'logged_in' });

      expect((await get(id)).status).toBe(404);

      reader.viewer = { kind: 'customer', contactId: crypto.randomUUID(), companyId: null };
      const response = await get(id);
      expect(response.status).toBe(307);
      expect(response.headers.get('cache-control')).toBe('private, max-age=240');
    });

    it('is not shown to a customer by an internal article', async () => {
      signs();
      const id = await picture();
      await articleShowing(id, { folder: 'agents_only' });
      reader.viewer = { kind: 'customer', contactId: crypto.randomUUID(), companyId: null };
      expect((await get(id)).status).toBe(404);
    });

    it('in a draft, or in no article yet, goes to an agent and nobody else', async () => {
      signs();
      const drafted = await picture();
      await articleShowing(drafted, { status: 'draft' });
      const loose = await picture();

      expect((await get(drafted)).status).toBe(404);
      expect((await get(loose)).status).toBe(404);

      reader.agent = true;
      expect((await get(drafted)).status).toBe(307);
      expect((await get(loose)).status).toBe(307);
    });
  });

  it('answers 404 for an id it does not hold, and for one that is not an id', async () => {
    const { mock } = signs();

    expect((await get(crypto.randomUUID())).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
    expect((await get("1' or '1'='1")).status).toBe(404);
    expect(mock).not.toHaveBeenCalled();
  });

  it('answers a Storage failure 502, uncached, and logs it', async () => {
    signs(() => new Response('{"error":"down"}', { status: 503 }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await picture();
    await articleShowing(id);

    const response = await get(id);

    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(String(errors.mock.calls[0]?.[0])).toContain(
      `[kb_images] could not serve picture ${id}`,
    );
  });
});
