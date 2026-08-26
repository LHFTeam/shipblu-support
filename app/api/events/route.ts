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

      try {
        listener = sessionSql();
        // One session connection owns every topic for this view. Register them
        // sequentially rather than pipelining LISTEN statements during the
        // connection's own startup; this runs once per stream, not per event.
        for (const topic of topics) {
          await listener.listen(topic, () => send('conversation', '{}'));
        }
        send('ready', '{}');
      } catch (error) {
        console.error('[sse] could not LISTEN', error);
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

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        void listener?.end();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener('abort', cleanup);
    },

    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      void listener?.end();
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
