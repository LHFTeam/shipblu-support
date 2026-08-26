import { describe, expect, it, vi } from 'vitest';

const destroySession = vi.fn(async () => {});
vi.mock('@/lib/auth/session', () => ({ destroySession }));

const { POST } = await import('./route');

/**
 * The regression this guards is not "does logout redirect" — it always did —
 * but *where* to. Building the target with `new URL('/login', request.url)`
 * resolves against the address the server is bound to rather than the Host it
 * was asked for, so on Render every sign-out answered
 * `Location: http://localhost:10000/login` and dropped the agent on a dead
 * address. Asserting the header is relative is the only form of this test that
 * fails on that bug, because a unit test has no real Host to compare against.
 */
describe('POST /api/auth/logout', () => {
  it('redirects with a relative Location, naming no host of its own', async () => {
    const response = await POST();
    const location = response.headers.get('location');

    expect(response.status).toBe(303);
    expect(location).toBe('/login');
    expect(location).not.toMatch(/^[a-z]+:\/\//i);
  });

  it('destroys the session before redirecting', async () => {
    destroySession.mockClear();
    await POST();
    expect(destroySession).toHaveBeenCalledTimes(1);
  });
});
