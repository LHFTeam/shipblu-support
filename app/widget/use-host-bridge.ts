'use client';

import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { HOST_SAYS, SOURCE, WIDGET_SAYS } from '@/lib/widget/protocol';
import type { Message, WidgetView } from '@/lib/widget/types';

/** A message to the page that embeds the widget. */
export function postToHost(message: Record<string, unknown>) {
  // '*' is correct here and only here: the widget does not know which origin
  // embedded it, and the payload carries nothing secret — an unread count.
  // The host's listener checks *our* origin, which is the half that matters.
  window.parent?.postMessage({ source: SOURCE.widget, ...message }, '*');
}

/**
 * The widget's side of the conversation with its host page: the unread badge it
 * reports, and what it does with what the host page tells it.
 *
 * The two effects run in the order they always have — the badge first, then
 * the listener that says hello — because `chat.tsx` calls this where the badge
 * effect was. Everything they act on stays the shell's: the session code owns
 * the identity, the reset count and the session itself, so this reads and calls
 * them rather than keeping copies.
 */
export function useHostBridge({
  hostOrigins,
  token,
  messages,
  view,
  panelOpen,
  setPanelOpen,
  seenCountRef,
  identityRef,
  resetsRef,
  compose,
  sendIdentity,
  startFreshSession,
}: {
  hostOrigins: string[];
  token: string | null;
  messages: Message[];
  view: WidgetView;
  panelOpen: boolean;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  seenCountRef: RefObject<number>;
  identityRef: RefObject<{ identity: unknown; signature: string | null } | null>;
  resetsRef: RefObject<number>;
  compose: (text: string) => void;
  sendIdentity: (forToken: string) => Promise<void>;
  startFreshSession: () => void;
}) {
  /*
   * A reply is unread until the visitor is actually looking at it.
   *
   * Which is two conditions, not one: the panel has to be open — an iframe is
   * told that by the host, since `display:none` fires no event inside it — and
   * the thread has to be the screen showing. Someone reading an FAQ with the
   * panel open is not reading their conversation, and badging them is how they
   * find out an agent answered.
   */
  useEffect(() => {
    const replies = messages.filter((message) => message.from === 'agent').length;
    if (panelOpen && view === 'thread') seenCountRef.current = replies;
    postToHost({ type: WIDGET_SAYS.unread, count: Math.max(0, replies - seenCountRef.current) });
  }, [messages, view, panelOpen, seenCountRef]);

  useEffect(() => {
    const onHostMessage = (event: MessageEvent) => {
      /*
       * The origin check, not the `source` tag, is what makes the rest of this
       * safe: `parent.frames` is reachable from any other frame on the host
       * page, so anything embedded alongside us could otherwise identify the
       * visitor as somebody else or wipe their session. Our own origin is
       * allowed because the help centre serves the snippet itself and frames
       * itself.
       */
      if (event.origin !== window.location.origin && !hostOrigins.includes(event.origin)) return;
      if (event.data?.source !== SOURCE.host) return;

      if (event.data.type === HOST_SAYS.opened) setPanelOpen(true);
      if (event.data.type === HOST_SAYS.closed) setPanelOpen(false);

      if (event.data.type === HOST_SAYS.identify) {
        identityRef.current = {
          identity: event.data.identity,
          signature: typeof event.data.signature === 'string' ? event.data.signature : null,
        };
        if (token) void sendIdentity(token);
      }

      /*
       * A host page opening the chat on a subject of its own.
       *
       * Capped well under the composer's own 5,000: this is a draft somebody is
       * meant to write under, and a host page — or anyone who can post to this
       * frame from an allowed origin — should not be able to fill the box.
       */
      if (event.data.type === HOST_SAYS.compose) {
        compose(typeof event.data.text === 'string' ? event.data.text.slice(0, 1000) : '');
      }

      // The host page signing its user out. Not merely an identity of null: the
      // point is that the next person at this browser starts clean.
      if (event.data.type === HOST_SAYS.clear) {
        identityRef.current = null;
        resetsRef.current = 0;
        startFreshSession();
      }
    };

    window.addEventListener('message', onHostMessage);

    /*
     * Ask, rather than assume.
     *
     * `toggle` posts to `contentWindow` the instant it creates the iframe, so
     * that first 'opened' lands on `about:blank` and is lost — as is a 'closed'
     * from a visitor who shuts the panel before the frame finishes loading, and
     * every locale switch re-points `src` and starts a fresh document. Any of
     * those leaves a hidden panel believing it is visible, which silently
     * swallows the unread badge. The host answers this with its real state.
     */
    postToHost({ type: WIDGET_SAYS.hello });

    return () => window.removeEventListener('message', onHostMessage);
  }, [
    compose,
    hostOrigins,
    identityRef,
    resetsRef,
    sendIdentity,
    setPanelOpen,
    startFreshSession,
    token,
  ]);
}
