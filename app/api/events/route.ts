import { sessionSql } from '@/db/client';
import { getSessionAgent } from '@/lib/auth/session';
import { beat, goOffline, goOnline } from '@/lib/assignment/presence';

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
 *
 * It doubles as the presence signal. An open stream is an agent with the console
 * in front of them, which is exactly the question auto-assignment needs answered
 * and exactly the one `agents.presence` had no writer for until now. Recording it
 * here rather than from a heartbeat endpoint of its own means there is nothing
 * extra to keep alive, and nothing that can disagree with the stream about
 * whether somebody is there.
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

      // Presence is recorded after LISTEN rather than before, so a database that
      // cannot be reached does not leave an agent marked online on a stream that
      // carries nothing. Failures are swallowed: presence is a routing hint, and
      // losing it must never cost the agent their live updates.
      void goOnline(agent.id).catch((error) => {
        console.error('[sse] could not record presence', error);
      });

      // Proxies drop idle connections at around 60s; a comment line keeps the
      // stream alive without being delivered as an event. It is also the
      // heartbeat that assignment reads — an agent whose beat has gone stale is
      // treated as gone whatever the presence column still says, which is what
      // makes an instance killed mid-stream heal itself.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          /* closed */
        }
        void beat(agent.id).catch(() => {
          /* the staleness check covers a missed beat */
        });
      }, 25_000);

      request.signal.addEventListener('abort', () => {
        if (heartbeat) clearInterval(heartbeat);
        void listener?.end();
        void goOffline(agent.id).catch(() => {
          /* the staleness check covers a missed sign-off */
        });
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
      // Both teardown paths sign off. `cancel` fires when the consumer drops the
      // stream, `abort` when the request is torn down; which one runs depends on
      // the runtime, and an agent left marked online is one who keeps receiving
      // tickets they cannot see.
      void goOffline(agent.id).catch(() => {
        /* the staleness check covers a missed sign-off */
      });
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
