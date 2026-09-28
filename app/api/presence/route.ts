import { currentSessionHash, getSessionAgent, sessionIsLive } from '@/lib/auth/session';
import { beat, goOffline, goOnline } from '@/lib/assignment/presence';
import { logger } from '@/lib/log';

const log = logger('presence');

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
  /** True while this stream's own beat chain is still outstanding. */
  let beating = false;

  // Assigned by `start`, called by `cancel` too — the two teardown paths must be
  // the same code, because they can both run for one stream. This route kept a
  // second copy of the sign-off in `cancel()` while the other two SSE routes
  // were consolidated; the copies had already drifted, the one in `cancel()`
  // never detaching the abort listener.
  let cleanup = () => {};

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
        log.error('could not record presence', error);
      });

      cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener('abort', cleanup);
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
        // The keepalive byte goes out first and synchronously. It is what stops
        // the proxy timing this stream out, and it must never wait on a
        // database: under pool pressure an awaited query here holds the byte
        // back for tens of seconds, the proxy closes every open stream, and
        // every console in the building reconnects at once — a slow database
        // turned into a stampede against the same database.
        sendKeepalive();

        // One chain at a time. The keepalive above is unconditional and
        // synchronous, so this stream stays open however slow the database is —
        // which means without this guard every 25s tick started another chain
        // that never settled. Over the fifty minutes of §62 that is roughly a
        // hundred and twenty of them per stream, each holding its closure and a
        // place in a queue that has no end, all while the browser saw a healthy
        // stream and had no reason to back off. Skipping a beat costs nothing:
        // the staleness check below already covers a missed one.
        if (beating) return;
        beating = true;

        void (async () => {
          try {
            // Then the session, before the beat rather than after it. A beat
            // first would put a signed-out agent back to `online` for 25
            // seconds, every time round the loop. A database that cannot answer
            // fails open — a blip must not sign the whole team out.
            if (tokenHash && !(await sessionIsLive(tokenHash).catch(() => true))) {
              cleanup();
              return;
            }

            await beat(agent.id).catch(() => {
              /* the staleness check covers a missed beat */
            });
          } finally {
            beating = false;
          }
        })();
      }, 25_000);
      sendKeepalive();

      request.signal.addEventListener('abort', cleanup);
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
