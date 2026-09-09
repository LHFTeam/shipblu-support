import { afterEach, describe, expect, it, vi } from 'vitest';

const getSessionAgent = vi.fn(async () => ({ role: 'admin', permissions: [] }));
vi.mock('@/lib/auth/session', () => ({ getSessionAgent }));

const end = vi.fn(async () => {});
const listen = vi.fn(async () => ({}));
const sessionSql = vi.fn(() => ({ listen, end }));
vi.mock('@/db/client', () => ({ sessionSql }));

vi.mock('@/lib/realtime/topics', () => ({
  parseQueueChannel: () => 'all',
  queueTopicsForAgent: () => ['queue_email', 'queue_whatsapp', 'queue_webchat'],
  conversationTopic: () => null,
}));
vi.mock('@/lib/realtime/authorization', () => ({ canSubscribeToConversation: async () => true }));

const { GET } = await import('./route');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.clearAllMocks());

/**
 * Opening this stream costs a session-mode connection plus one round trip per
 * topic, and an agent moving between tickets aborts the previous request inside
 * that window routinely. The handler used to be attached after the loop, where
 * an already-fired signal meant it never ran at all — production kept a
 * `listen "conversation_…"` open for half an hour after its request finished.
 */
describe('GET /api/events', () => {
  it('opens no session connection when the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await GET(
      new Request('http://localhost/api/events?channel=all', { signal: controller.signal }),
    );
    await settle();

    expect(sessionSql).not.toHaveBeenCalled();
  });

  it('closes the connection when the abort lands mid-LISTEN, and stops registering', async () => {
    const controller = new AbortController();
    listen.mockImplementationOnce(async () => {
      controller.abort();
      return {};
    });

    await GET(
      new Request('http://localhost/api/events?channel=all', { signal: controller.signal }),
    );
    await settle();

    // Bailed after the first topic rather than working through the rest, and
    // the connection it had already opened was ended exactly once.
    expect(listen).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
