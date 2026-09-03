import { currentSessionHash, getSessionAgent, sessionIsLive } from '@/lib/auth/session';
import { beat, goOffline, goOnline } from '@/lib/assignment/presence';

export const dynamic = 'force-dynamic';

/**
 * Agent-presence heartbeat for the whole console.
 *
 * Kept separate from inbox invalidations so an agent remains eligible for work
 * while reading Contacts, Reports or Admin, without those pages holding a
 * PostgreSQL LISTEN connection or refreshing on ticket traffic.
 *
 * The keepalive re-checks the session, which it has to: this is the one request
 * in the system that is authorised once and then keeps writing for hours. A
 * session revoked underneath it — an agent deactivated, a password changed, or
 * the inactivity sign-out reaching a console nobody closed — would otherwise go
 * on beating its owner back to `online` every 25 seconds, for as long as the
 * abandoned tab stayed open, and the rota would keep handing them tickets.
 */
export async function GET(request: Request) {
  const agent = await getSessionAgent();
  if (!agent) return new Response('unauthorised', { status: 401 });

  // Captured now, while a cookie can still be read. The hash is what the table
  // stores, so holding it for the life of the stream leaks nothing replayable.
  const tokenHash = await currentSessionHash();

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

      // The beat is both a proxy keepalive and assignment's proof that this
      // stream is still alive. A killed instance heals through staleness even
      // when it never gets a chance to run the sign-off below.
      heartbeat = setInterval(() => {
        void (async () => {
          // Order matters: prove the session is still there before asserting the
          // agent is. A beat first would put them back online for 25 seconds
          // after they were signed out, every time round the loop.
          if (tokenHash && !(await sessionIsLive(tokenHash).catch(() => true))) {
            cleanup();
            return;
          }

          sendKeepalive();
          await beat(agent.id).catch(() => {
            /* the staleness check covers a missed beat */
          });
        })();
      }, 25_000);
      sendKeepalive();

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
