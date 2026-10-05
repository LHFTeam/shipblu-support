import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The id is a path segment, so it arrives as whatever somebody typed into the
 * address bar. Postgres answers a malformed uuid with error 22P02, which reached
 * the agent as a 500 — a server fault for what is only a link to nothing.
 */

const select = vi.fn<() => unknown>(() => {
  throw new Error('the database was asked about an id that cannot exist');
});
const signedUrl = vi.fn(async (_path: string, _ttl: number) => 'https://storage.example/signed');
vi.mock('@/db/client', () => ({ db: { select } }));
vi.mock('@/lib/auth/session', () => ({
  getSessionAgent: async () => ({ id: 'agent-1', role: 'admin', permissions: {} }),
}));
vi.mock('@/lib/storage', () => ({ signedUrl }));

/** The drizzle builder chain, answering `limit()` with the rows given. */
function rows(found: unknown[]) {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => found,
  };
  return chain;
}

const { GET } = await import('./route');
const { ATTACHMENT_URL_TTL_SECONDS } = await import('@/lib/attachments/signed-url');

function get(id: string) {
  return GET(new Request(`https://support.example/api/attachments/${id}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  select.mockClear();
  signedUrl.mockClear();
});

describe('GET /api/attachments/[id]', () => {
  it('answers a malformed id with 404, without asking the database', async () => {
    const response = await get('not-a-uuid');

    expect(response.status).toBe(404);
    expect(select).not.toHaveBeenCalled();
  });

  it('still asks the database about a well-formed id', async () => {
    await expect(get('0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44')).rejects.toThrow(/cannot exist/);
    expect(select).toHaveBeenCalledTimes(1);
  });

  /*
    An inline player reloads through this route on purpose to get a fresh
    signature, because every browser sends its later range requests straight to
    the signed URL. A redirect the browser kept would hand it the dead one back.
  */
  it('redirects to a URL signed for the shared lifetime, and says not to keep it', async () => {
    select.mockImplementationOnce(() =>
      rows([
        {
          storagePath: 'conversations/c/m-0.ogg',
          assigneeAgentId: 'agent-1',
          channel: 'whatsapp',
        },
      ]),
    );

    const response = await get('0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44');

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://storage.example/signed');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(signedUrl).toHaveBeenCalledWith('conversations/c/m-0.ogg', ATTACHMENT_URL_TTL_SECONDS);
  });
});
