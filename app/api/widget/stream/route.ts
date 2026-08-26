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

      try {
        if (topic) {
          listener = sessionSql();
          await listener.listen(topic, () => void push());
        }
        send('ready', {});
      } catch (error) {
        console.error('[widget:sse] could not LISTEN', error);
        // The widget falls back to polling on this, rather than sitting on a
        // stream that will never carry anything.
        send('degraded', {});
      }

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
      'X-Accel-Buffering': 'no',
    },
  });
}
