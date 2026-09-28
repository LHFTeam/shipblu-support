'use client';

import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Message } from '@/lib/widget/types';

/**
 * Live agent replies for the widget's current session: the event stream, with
 * a 15-second poll of `/api/widget/session` whenever the stream degrades or
 * fails.
 *
 * It owns no state. What it reads back is written through the shell's own
 * setters, because the session code in `chat.tsx` writes the same values and
 * the transcript must have one owner. The effect lists each field on its own
 * rather than the object they arrive in, which is new every render: React's
 * setters and the ref never change, so the stream reopens only when the token
 * or the conversation does, as it did inline. `activeToken` is the shell's ref,
 * read back before anything is painted.
 */
export function useMessageStream({
  token,
  conversationId,
  activeToken,
  setConversationId,
  setMessages,
  setOnline,
  setOpensAt,
}: {
  token: string | null;
  conversationId: string | null;
  activeToken: RefObject<string | null>;
  setConversationId: Dispatch<SetStateAction<string | null>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setOnline: Dispatch<SetStateAction<boolean>>;
  setOpensAt: Dispatch<SetStateAction<string | null>>;
}) {
  useEffect(() => {
    if (!token) return;

    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const refresh = () => {
      void fetch('/api/widget/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          // Same reason as the guard in `send` in `chat.tsx`: the interval is
          // cleared when the token changes, but a request already issued still
          // resolves, and painting its answer would put the previous person's
          // transcript in front of the next one.
          if (data && activeToken.current === token) {
            setConversationId(data.conversationId);
            setMessages(data.messages);
            setOnline(Boolean(data.online));
            setOpensAt((data.opensAt as string | null) ?? null);
          }
        })
        .catch(() => {});
    };

    const startPolling = () => {
      if (!poll) poll = setInterval(refresh, 15_000);
    };

    try {
      source = new EventSource(`/api/widget/stream?token=${encodeURIComponent(token)}`);
      source.addEventListener('messages', (event) => {
        setMessages(JSON.parse((event as MessageEvent).data) as Message[]);
      });
      source.addEventListener('degraded', startPolling);
      source.onerror = startPolling;
      source.addEventListener('ready', () => {
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
      });
    } catch {
      startPolling();
    }

    return () => {
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [token, conversationId, activeToken, setConversationId, setMessages, setOnline, setOpensAt]);
}
