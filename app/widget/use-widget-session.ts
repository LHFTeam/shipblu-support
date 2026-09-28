'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { initialView } from '@/lib/widget/view';
import type { Message, WidgetView } from '@/lib/widget/types';

const STORAGE_KEY = 'shipblu.widget.token';

/**
 * The visitor's session with the widget: the token, the transcript it owns, and
 * everything that decides which token that is — resuming one on load, minting
 * one when somebody chooses to talk, and throwing it away when the host page
 * says the person at this browser has changed.
 *
 * The screen stays the shell's. What this does to it — open the thread on a
 * resumed conversation, go back to the questions on a reset — goes through the
 * setters it is handed, and `navigatedRef` is the shell's record of whether the
 * visitor has already chosen a screen. The four other refs are the shell's too,
 * because the send path and the host bridge write them as well; only the two
 * nothing else reads, `minting` and `identified`, live here.
 */
export function useWidgetSession({
  initialOnline,
  initialOpensAt,
  seenCountRef,
  activeTokenRef,
  identityRef,
  resetsRef,
  navigatedRef,
  setView,
  setThreadStarted,
}: {
  initialOnline: boolean;
  initialOpensAt: string | null;
  seenCountRef: RefObject<number>;
  activeTokenRef: RefObject<string | null>;
  identityRef: RefObject<{ identity: unknown; signature: string | null } | null>;
  resetsRef: RefObject<number>;
  navigatedRef: RefObject<boolean>;
  setView: Dispatch<SetStateAction<WidgetView>>;
  setThreadStarted: Dispatch<SetStateAction<boolean>>;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

  /*
   * Seeded by the server render, then refreshed by every session response.
   *
   * The panel is created once and can sit open across the moment the team opens
   * or closes; a value fixed at render would keep telling a visitor at 18:05
   * that we reply in a few minutes, and — because this also decides whether the
   * out-of-hours form is asked for — would file their message with no way back.
   * `/api/widget/session` already computes and returns both on every call,
   * including the degraded 15s poll; before this nothing read them.
   */
  const [online, setOnline] = useState(initialOnline);
  const [opensAt, setOpensAt] = useState(initialOpensAt);

  const [detailsSaved, setDetailsSaved] = useState(false);

  /* One session request at a time. Without this, `talkToAgent` firing one and a
     fast Send firing another both see `token` still null and both POST an empty
     token — which the route answers by minting a *second* contact, filing the
     message against whichever won, and orphaning the other. */
  const minting = useRef<Promise<string | null> | null>(null);
  /** `token:payload` of the last identity actually sent, so opens are cheap. */
  const identified = useRef<string | null>(null);

  // --- Session -------------------------------------------------------------

  /*
   * Resumed on load, but never minted there.
   *
   * `POST /api/widget/session` writes a `contacts` row for a token it does not
   * recognise, so calling it on every load would file a customer record for
   * everyone who opened the panel to read an FAQ and left. The same rule the
   * tracking lookup follows: an unauthenticated read never writes a row, or the
   * table becomes a place anyone can put things. A visitor becomes a contact at
   * the moment they choose to talk to somebody, which is `ensureSession` below.
   */
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;

    void fetch('/api/widget/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: stored }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data) return;
        localStorage.setItem(STORAGE_KEY, data.token);
        activeTokenRef.current = data.token;
        setToken(data.token);
        setConversationId(data.conversationId);
        setMessages(data.messages);
        setDetailsSaved(Boolean(data.detailsSaved));
        setOnline(Boolean(data.online));
        setOpensAt((data.opensAt as string | null) ?? null);
        seenCountRef.current = data.messages.filter((m: Message) => m.from === 'agent').length;
        // A visitor coming back to a live conversation wants the reply they came
        // back for, not the FAQ list.
        // Only if they have not already chosen a screen while this was in
        // flight — otherwise a slow resume yanks a visitor out of the article
        // they opened, or unmounts the thread they are typing into.
        if (!navigatedRef.current) {
          const opening = initialView({ messageCount: data.messages.length });
          if (opening === 'thread') setThreadStarted(true);
          setView(opening);
        }
      })
      .catch(() => {
        // Leaves the home screen up, which is rendered from props and needs
        // nothing from this call.
      });
  }, [activeTokenRef, navigatedRef, seenCountRef, setThreadStarted, setView]);

  /**
   * The token, minting one on first use. Resolves null only if the server did.
   *
   * Single-flight, and deliberately so. `talkToAgent` starts one without
   * awaiting it so the screen changes immediately, and a visitor typing fast
   * reaches `send` before `setToken` has landed — two callers, both seeing
   * `token` as null. Without the shared promise each would POST an empty token,
   * and `/api/widget/session` answers an unrecognised one by registering a new
   * contact: two customer records, two tokens racing for the same localStorage
   * key, and the message filed against whichever won.
   *
   * The stored token is read back inside the promise rather than trusted from
   * the closure, so a resume that settled in the meantime is used instead of
   * being overwritten.
   */
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (token) return token;
    if (minting.current) return minting.current;

    const request = (async () => {
      const stored = localStorage.getItem(STORAGE_KEY) ?? '';

      const data = await fetch('/api/widget/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: stored }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

      if (!data) return null;

      localStorage.setItem(STORAGE_KEY, data.token);
      activeTokenRef.current = data.token;
      setToken(data.token);
      setConversationId(data.conversationId);
      setMessages(data.messages);
      setDetailsSaved(Boolean(data.detailsSaved));
      setOnline(Boolean(data.online));
      setOpensAt((data.opensAt as string | null) ?? null);
      return data.token as string;
    })();

    minting.current = request;
    try {
      return await request;
    } finally {
      minting.current = null;
    }
  }, [token, activeTokenRef]);

  // --- Who the host page says this is --------------------------------------

  /**
   * Throws the visitor token away and returns to the opening screen.
   *
   * The transcript is dropped with it, which is the entire point: this runs when
   * the host page's signed-in user has changed, and the previous person's
   * conversation must not be on screen for the next one.
   *
   * It does not open a replacement session, because nothing here needs one yet.
   * The widget mints a token when somebody chooses to talk, so a browser whose
   * merchant just signed out goes back to the questions and files no contact row
   * until the next person actually writes something. The identity is kept, and
   * `sendIdentity` attaches it to whatever token comes next.
   */
  const startFreshSession = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    activeTokenRef.current = null;
    identified.current = null;
    seenCountRef.current = 0;
    setToken(null);
    setConversationId(null);
    setMessages([]);
    setDetailsSaved(false);
    setThreadStarted(false);
    setView('home');
  }, [activeTokenRef, seenCountRef, setThreadStarted, setView]);

  const sendIdentity = useCallback(
    async (forToken: string) => {
      const pending = identityRef.current;
      if (!pending) return;

      // The host re-sends on every open and on every navigation of its own SPA,
      // so the common case is an identity the server already has.
      const fingerprint = `${forToken}:${JSON.stringify(pending)}`;
      if (identified.current === fingerprint) return;
      identified.current = fingerprint;

      const response = await fetch('/api/widget/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: forToken, ...pending }),
      }).catch(() => null);

      // Retried on the next open rather than left unsaid: the fingerprint is
      // what makes the common case free, and keeping it after a failure would
      // cost the agent the customer's name for the rest of the session.
      if (!response?.ok) {
        identified.current = null;
        return;
      }

      const data = (await response.json().catch(() => null)) as { reset?: boolean } | null;
      if (data?.reset && resetsRef.current < 2) {
        resetsRef.current += 1;
        startFreshSession();
      }
    },
    [identityRef, resetsRef, startFreshSession],
  );

  return {
    token,
    conversationId,
    setConversationId,
    messages,
    setMessages,
    online,
    setOnline,
    opensAt,
    setOpensAt,
    detailsSaved,
    setDetailsSaved,
    ensureSession,
    startFreshSession,
    sendIdentity,
  };
}
