import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTestEnv } from '@/lib/testing/env';
import { widgetFileUrl } from '@/lib/widget/file-links';

/**
 * What a widget's file link answers, around the signature (`file-links.ts`,
 * tested beside it) and the query that asks what changed since it was signed
 * (`widgetAttachmentPath`, tested against Postgres in
 * `lib/widget/conversation.db.test.ts`).
 */

withTestEnv();

const OWN = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const GONE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const widgetAttachmentPath = vi.fn(async (id: string) =>
  id === OWN ? 'conversations/c/m-0.jpg' : null,
);
const signedUrl = vi.fn(async (path: string) => `https://storage.example/signed/${path}`);
vi.mock('@/lib/widget/conversation', () => ({ widgetAttachmentPath }));
vi.mock('@/lib/storage', () => ({ signedUrl }));

const { GET } = await import('./route');

let address = 0;
function get(path: string, id = path.split('/').at(-1)!.split('?')[0]!) {
  address += 1;
  return GET(
    new Request(new URL(path, 'https://support.example'), {
      headers: { 'x-forwarded-for': `198.18.0.${address % 250}` },
    }),
    { params: Promise.resolve({ id: decodeURIComponent(id) }) },
  );
}

beforeEach(() => {
  widgetAttachmentPath.mockClear();
  signedUrl.mockClear();
});

describe('GET /api/widget/attachments/[id]', () => {
  it('redirects a link the transcript signed to a fresh Storage URL, and says not to keep it', async () => {
    const response = await get(widgetFileUrl(OWN, new Date()));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://storage.example/signed/conversations/c/m-0.jpg',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(widgetAttachmentPath).toHaveBeenCalledWith(OWN);
  });

  it('answers a signed link to a file that is no longer reachable as one that does not exist', async () => {
    const response = await get(widgetFileUrl(GONE, new Date()));

    expect(response.status).toBe(404);
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it('refuses another file’s signature, an expired link and a bare id, before asking anything', async () => {
    const signedForOther = widgetFileUrl(GONE, new Date()).replace(GONE, OWN);
    const expired = widgetFileUrl(OWN, new Date('2026-01-01T00:00:00Z'));

    for (const path of [signedForOther, expired, `/api/widget/attachments/${OWN}`]) {
      expect((await get(path)).status).toBe(404);
    }
    expect(widgetAttachmentPath).not.toHaveBeenCalled();
  });

  it('no longer takes the visitor’s token', async () => {
    expect((await get(`/api/widget/attachments/${OWN}?token=anything`)).status).toBe(404);
  });

  it('answers a malformed id as a link to nothing', async () => {
    expect((await get('/api/widget/attachments/not-a-uuid')).status).toBe(404);
    expect(widgetAttachmentPath).not.toHaveBeenCalled();
  });
});
