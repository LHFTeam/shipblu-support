import { sessionSql } from '@/db/client';
import { listMessages } from '@/lib/widget/conversation';
import { findLiveConversation, resolveVisitor } from '@/lib/widget/session';
import { conversationTopic } from '@/lib/realtime/topics';

export const dynamic = 'force-dynamic';

/**
 * Live agent replies for one visitor.
 *
 * The visitor token is resolved before choosing a per-conversation topic. A
 * widget therefore never receives another ticket's notification and never
 * re-reads its transcript because unrelated traffic happened elsewhere.
 *
 * The notification is still only a signal — its payload is discarded and the
 * transcript is re-read through `listMessages`, which is scoped to the
 * conversation resolved from the bearer token and excludes private notes.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const contactId = await resolveVisitor(token);
  if (!contactId) return new Response('unauthorised', { status: 401 });

  // A brand-new visitor has no conversation until their first send. Their
  // client reconnects with the returned conversation id after that write; until
  // then this stream needs only its keepalive and no database connection.
  const conversationId = await findLiveConversation(contactId);
  const topic = conversationId ? conversationTopic(conversationId) : null;

  const encoder = new TextEncoder();
  let listener: ReturnType<typeof sessionSql> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let pushing = false;
  let pushAgain = false;

  /**
   * Releases the session connection, once, and says so when it fails. Same
   * reasoning as the console stream in `app/api/events/route.ts`: a session
   * client is opened with `idle_timeout: 0`, so a floating `end()` that never
   * completed is indistinguishable from one that did, and the backend is held
   * until something reaps it (§62).
   */
  const releaseListener = async () => {
    const held = listener;
    if (!held) return;
    listener = null;
    try {
      await held.end({ timeout: 5 });
    } catch (error) {
      console.error('[widget:sse] failed to release the LISTEN connection', error);
    }
  };

  // Assigned by `start`, called by `cancel` too — one teardown, two callers.
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The visitor navigated away between the notification and the write.
        }
      };

      /** Re-reads the visitor's own transcript. Never trusts the payload. */
      const push = async () => {
        if (!conversationId) return;
        if (pushing) {
          pushAgain = true;
          return;
        }

        pushing = true;
        try {
          do {
            pushAgain = false;
            send('messages', await listMessages(conversationId));
          } while (pushAgain && !closed);
        } catch (error) {
          console.error('[widget:sse] refresh failed', error);
        } finally {
          pushing = false;
        }
      };

      cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener('abort', cleanup);
        void releaseListener();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Wired before the connection is opened rather than after it is
      // listening: a visitor who closes the tab while the LISTEN round trip is
      // in flight would otherwise leave nothing attached to the request
      // lifecycle, and the backend stranded (§62).
      request.signal.addEventListener('abort', cleanup);

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          /* closed */
        }
      }, 25_000);

      try {
        if (topic) {
          listener = sessionSql();
          await listener.listen(topic, () => void push());
        }

        // Moving the abort handler up is not enough by itself: `listener` is
        // still null when an abort arrives mid-await, so `cleanup` releases
        // nothing and the connection assigned a moment later belongs to a
        // visitor who has already gone.
        if (closed) {
          await releaseListener();
          return;
        }

        send('ready', {});
      } catch (error) {
        console.error('[widget:sse] could not LISTEN', error);
        // The connection can be live even when a LISTEN on it failed, so it is
        // released here rather than left to a cleanup that may never run.
        await releaseListener();
        // The widget falls back to polling on this, rather than sitting on a
        // stream that will never carry anything.
        send('degraded', {});
      }
    },

    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
