import { sessionSql } from '@/db/client';
import { getSessionAgent } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Server-sent events for live inbox updates.
 *
 * Backed by Postgres LISTEN/NOTIFY rather than Redis: NOTIFY reaches every
 * listening connection, so this works unchanged across autoscaled instances
 * with no extra infrastructure. Each connected agent holds one session-mode
 * connection, which is why the console reconnects rather than opening several.
 *
 * The payload is deliberately just "something changed on conversation X" — the
 * client refetches through the normal authorised path, so the stream never
 * becomes a way to receive tickets the agent cannot otherwise see.
 */
export async function GET(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });

  const encoder = new TextEncoder();
  let listener: ReturnType<typeof sessionSql> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // The client went away between the notification and the write.
        }
      };

      try {
        listener = sessionSql();
        await listener.listen('conversation_changed', (payload) => send('conversation', payload));
        send('ready', '{}');
      } catch (error) {
        console.error('[sse] could not LISTEN', error);
        // Tell the client to fall back to polling rather than leaving it
        // waiting on a stream that will never carry anything.
        send('degraded', '{}');
      }

      // Proxies drop idle connections at around 60s; a comment line keeps the
      // stream alive without being delivered as an event.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          /* closed */
        }
      }, 25_000);

      request.signal.addEventListener('abort', () => {
        if (heartbeat) clearInterval(heartbeat);
        void listener?.end();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },

    cancel() {
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
