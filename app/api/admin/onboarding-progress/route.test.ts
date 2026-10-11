import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The poll the Channels page runs while a number connects. What matters is
 * that it answers only the people the page itself would, and never from a
 * cache: a stale version is a page that stops updating.
 */

type Agent = { id: string; role: string; permissions: Record<string, boolean> };

const session = vi.fn<() => Promise<Agent | null>>();
const readProgressVersion = vi.fn(async (_now: Date) => 'v1');
vi.mock('@/lib/auth/session', () => ({ getSessionAgent: () => session() }));
vi.mock('@/lib/whatsapp/onboarding-reads', () => ({ readProgressVersion }));

const { GET } = await import('./route');

beforeEach(() => {
  session.mockReset();
  readProgressVersion.mockClear();
});

describe('GET /api/admin/onboarding-progress', () => {
  it('answers 401 without a session, without reading anything', async () => {
    session.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(readProgressVersion).not.toHaveBeenCalled();
  });

  it('answers 403 to an agent the Channels page would turn away', async () => {
    session.mockResolvedValue({ id: 'a-1', role: 'agent', permissions: {} });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(readProgressVersion).not.toHaveBeenCalled();
  });

  it('answers an admin with the version, uncached', async () => {
    session.mockResolvedValue({ id: 'a-2', role: 'admin', permissions: {} });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ version: 'v1' });
  });
});
