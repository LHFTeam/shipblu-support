import { sessionSql } from '@/db/client';
import { listMessages } from '@/lib/widget/conversation';
import { findLiveConversation, resolveVisitor } from '@/lib/widget/session';

export const dynamic = 'force-dynamic';

/**
 * Live agent replies for one visitor.
 *
 * Same LISTEN/NOTIFY plumbing as the console's stream, with one important
 * difference: the console's stream serves an authenticated agent, this one
 * serves anyone holding a visitor token. So the notification is used only as a
 * *signal* — the payload is discarded and the transcript is re-read through
 * `listMessages`, which is scoped to this visitor's conversation and already
 * excludes private notes.
 *
 * Reading the notification payload directly would be faster and would be a way
 * to hand one visitor another visitor's messages the first time the trigger
 * changed shape.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const contactId = await resolveVisitor(token);
  if (!contactId) return new Response('unauthorised', { status: 401 });

  const encoder = new TextEncoder();
  let listener: ReturnType<typeof sessionSql> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

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
        try {
          const conversationId = await findLiveConversation(contactId);
          if (!conversationId) return;
          send('messages', await listMessages(conversationId));
        } catch (error) {
          console.error('[widget:sse] refresh failed', error);
        }
      };

      try {
        listener = sessionSql();
        await listener.listen('conversation_changed', () => void push());
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
