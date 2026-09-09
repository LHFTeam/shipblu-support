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

      // Nulled before ending so the two paths that can reach it — the abort
      // handler and the setup checks below — cannot both close the same client,
      // and so a client created after an abort is still closed by the checks.
      const closeListener = () => {
        const client = listener;
        listener = null;
        void client?.end();
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        closeListener();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      /**
       * Registered before the first await, and not after the LISTEN loop.
       *
       * Opening this stream costs a connection plus one round trip per topic —
       * eight of them for `channel=all` — and an agent moving between tickets
       * aborts the previous request inside that window routinely. Attaching the
       * handler afterwards attached it to a signal that had already fired, and
       * an `abort` listener added to an aborted signal never runs: `cleanup`
       * never happened, and the session connection stayed open for as long as
       * the process did. One was still holding its LISTEN half an hour after
       * its request completed (`docs/PROJECT-STATE.md` §5).
       */
      if (request.signal.aborted) return cleanup();
      request.signal.addEventListener('abort', cleanup);

      try {
        listener = sessionSql();
        // The abort may have fired while there was nothing yet to close.
        if (closed) return closeListener();
        // One session connection owns every topic for this view. Register them
        // sequentially rather than pipelining LISTEN statements during the
        // connection's own startup; this runs once per stream, not per event.
        for (const topic of topics) {
          await listener.listen(topic, () => send('conversation', '{}'));
          if (closed) return closeListener();
        }
        send('ready', '{}');
      } catch (error) {
        console.error('[sse] could not LISTEN', error);
        if (closed) return closeListener();
        // Tell the client to fall back to polling rather than leaving it
        // waiting on a stream that will never carry anything.
        send('degraded', '{}');
      }

      // Proxies drop idle connections at around 60s; a comment line keeps the
      // stream alive without becoming an event or a route refresh.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          /* closed */
        }
      }, 25_000);
    },

    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      const client = listener;
      listener = null;
      void client?.end();
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
