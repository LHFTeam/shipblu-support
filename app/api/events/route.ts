import { sessionSql } from '@/db/client';
import { getSessionAgent } from '@/lib/auth/session';
import { canSubscribeToConversation } from '@/lib/realtime/authorization';
import { conversationTopic, parseQueueChannel, queueTopicsForAgent } from '@/lib/realtime/topics';

export const dynamic = 'force-dynamic';

/**
 * Server-sent invalidations for one authorised inbox view.
 *
 * Queue notifications are partitioned by channel and ticket notifications by
 * conversation UUID. A default inbox therefore never receives customer-bot
 * traffic, while an open ticket receives delivery updates only for itself.
 *
 * The database payload is discarded. The browser learns only that its own view
 * is stale and re-fetches through the normal authorised queries. Presence has a
 * separate lightweight stream so leaving the inbox does not make an agent look
 * offline and this endpoint owns exactly one session-mode LISTEN connection.
 */
export async function GET(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });

  const url = new URL(request.url);
  // Missing means `all` for a zero-downtime deploy: a browser still running the
  // previous client bundle calls `/api/events` without a query string.
  const channel = parseQueueChannel(url.searchParams.get('channel'));
  if (!channel) return new Response('unknown channel', { status: 400 });

  const topics = queueTopicsForAgent(agent, channel);
  if (!topics) return new Response('forbidden', { status: 403 });

  const requestedConversationId = url.searchParams.get('conversationId');
  if (requestedConversationId) {
    const topic = conversationTopic(requestedConversationId);
    if (!topic) return new Response('invalid conversation', { status: 400 });
    if (!(await canSubscribeToConversation(agent, requestedConversationId))) {
      return new Response('not found', { status: 404 });
    }
    topics.push(topic);
  }

  const encoder = new TextEncoder();
  let listener: ReturnType<typeof sessionSql> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  /**
   * Releases the session connection, once, and says so when it fails.
   *
   * This used to be `void listener?.end()` in three places. A session client is
   * opened with `idle_timeout: 0`, so it holds a backend until something ends
   * it — and a floating promise means an `end()` that never completed looked
   * exactly like one that did. Five of these leaked on 2026-09-08 and were only
   * found because `transaction_timeout` reaped them (§5, §62).
   */
  const releaseListener = async () => {
    const held = listener;
    if (!held) return;
    listener = null;
    try {
      await held.end({ timeout: 5 });
    } catch (error) {
      console.error('[sse] failed to release the LISTEN connection', error);
    }
  };

  // Assigned by `start`, called by `cancel` too — the two teardown paths must be
  // the same code, because they can both run for one stream.
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // The client went away between the notification and the write.
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

      // Wired before the connection is opened rather than after it is listening.
      // The seven LISTEN round trips below are seven chances for the client to
      // go away, and while this listener was registered after them there was
      // nothing at all attached to the request lifecycle for that whole window
      // — so an abort during it stranded the backend permanently (§62).
      request.signal.addEventListener('abort', cleanup);

      // Armed early for the same reason: a stream that takes a while to start
      // listening still has to look alive to the proxy in front of it. Proxies
      // drop idle connections at around 60s; a comment line keeps the stream
      // alive without becoming an event or a route refresh.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          /* closed */
        }
      }, 25_000);

      try {
        // Held locally as well as on `listener`, because `releaseListener()`
        // nulls the shared reference the moment an abort arrives — and it can
        // arrive during any of the awaits below. Reading `listener.listen` on
        // the next iteration would then throw a TypeError that the catch logs
        // as "could not LISTEN", inventing a failure of the one step that had
        // in fact succeeded. The `closed` check is what actually stops the loop.
        const client = sessionSql();
        listener = client;

        // One session connection owns every topic for this view. Register them
        // sequentially rather than pipelining LISTEN statements during the
        // connection's own startup; this runs once per stream, not per event.
        for (const topic of topics) {
          if (closed) break;
          await client.listen(topic, () => send('conversation', '{}'));
        }

        // Moving the abort handler up is not enough on its own. `listener` is
        // still null when an abort arrives mid-await, so `cleanup` runs with
        // nothing to release and the connection assigned a moment later belongs
        // to a request that has already gone.
        if (closed) {
          await releaseListener();
          return;
        }

        send('ready', '{}');
      } catch (error) {
        console.error('[sse] could not LISTEN', error);
        // The connection may be live even though a LISTEN on it failed, so it
        // is released here rather than left to a cleanup that may never run.
        await releaseListener();
        // Tell the client to fall back to polling rather than leaving it
        // waiting on a stream that will never carry anything.
        send('degraded', '{}');
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
      // Render sits behind a proxy that would otherwise buffer the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
