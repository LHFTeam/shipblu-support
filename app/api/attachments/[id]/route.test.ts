import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The id is a path segment, so it arrives as whatever somebody typed into the
 * address bar. Postgres answers a malformed uuid with error 22P02, which reached
 * the agent as a 500 — a server fault for what is only a link to nothing.
 */

const select = vi.fn(() => {
  throw new Error('the database was asked about an id that cannot exist');
});
vi.mock('@/db/client', () => ({ db: { select } }));
vi.mock('@/lib/auth/session', () => ({
  getSessionAgent: async () => ({ id: 'agent-1', role: 'admin' }),
}));
vi.mock('@/lib/storage', () => ({ signedUrl: async () => 'https://storage.example/signed' }));

const { GET } = await import('./route');

function get(id: string) {
  return GET(new Request(`https://support.example/api/attachments/${id}`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  select.mockClear();
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
});
