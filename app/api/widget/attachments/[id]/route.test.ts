import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the visitor's file route answers, around the query that decides which
 * files a token reaches (`visitorAttachmentPath`, tested against Postgres in
 * `lib/widget/conversation.db.test.ts`).
 */

const resolveVisitor = vi.fn(async (token: string) => (token === 'known' ? 'contact-1' : null));
const visitorAttachmentPath = vi.fn(async (_contact: string, id: string) =>
  id === OWN ? 'conversations/c/m-0.jpg' : null,
);
const signedUrl = vi.fn(async (path: string) => `https://storage.example/signed/${path}`);

vi.mock('@/lib/widget/session', () => ({ resolveVisitor }));
vi.mock('@/lib/widget/conversation', () => ({ visitorAttachmentPath }));
vi.mock('@/lib/storage', () => ({ signedUrl }));

const OWN = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const { GET } = await import('./route');

let address = 0;
function get(id: string, token: string | null) {
  address += 1;
  const query = token === null ? '' : `?token=${encodeURIComponent(token)}`;
  return GET(
    new Request(`https://support.example/api/widget/attachments/${id}${query}`, {
      headers: { 'x-forwarded-for': `198.18.0.${address % 250}` },
    }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  resolveVisitor.mockClear();
  visitorAttachmentPath.mockClear();
  signedUrl.mockClear();
});

describe('GET /api/widget/attachments/[id]', () => {
  it('redirects to a fresh signed URL for the visitor’s own file, and says not to keep it', async () => {
    const response = await get(OWN, 'known');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://storage.example/signed/conversations/c/m-0.jpg',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(visitorAttachmentPath).toHaveBeenCalledWith('contact-1', OWN);
  });

  it('answers a file the token does not reach as one that does not exist', async () => {
    const response = await get(OTHER, 'known');

    expect(response.status).toBe(404);
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it('refuses without a session it knows', async () => {
    expect((await get(OWN, 'stranger')).status).toBe(401);
    expect((await get(OWN, null)).status).toBe(401);
    expect(visitorAttachmentPath).not.toHaveBeenCalled();
  });

  it('answers a malformed id as a link to nothing, before asking anything', async () => {
    const response = await get('not-a-uuid', 'known');

    expect(response.status).toBe(404);
    expect(resolveVisitor).not.toHaveBeenCalled();
  });
});
