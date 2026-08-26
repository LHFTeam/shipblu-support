import { getSessionAgent } from '@/lib/auth/session';
import { beat, goOffline, goOnline } from '@/lib/assignment/presence';

export const dynamic = 'force-dynamic';

/**
 * Agent-presence heartbeat for the whole console.
 *
 * Kept separate from inbox invalidations so an agent remains eligible for work
 * while reading Contacts, Reports or Admin, without those pages holding a
 * PostgreSQL LISTEN connection or refreshing on ticket traffic.
 */
export async function GET(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });

  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const sendKeepalive = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          /* closed */
        }
      };

      void goOnline(agent.id).catch((error) => {
        console.error('[presence] could not record presence', error);
      });

      // The beat is both a proxy keepalive and assignment's proof that this
      // stream is still alive. A killed instance heals through staleness even
      // when it never gets a chance to run the sign-off below.
      heartbeat = setInterval(() => {
        sendKeepalive();
        void beat(agent.id).catch(() => {
          /* the staleness check covers a missed beat */
        });
      }, 25_000);
      sendKeepalive();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        void goOffline(agent.id).catch(() => {
          /* the staleness check covers a missed sign-off */
        });
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener('abort', cleanup);
    },

    cancel() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
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
      'X-Accel-Buffering': 'no',
    },
  });
}
