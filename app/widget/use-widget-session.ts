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
import {
  mayResume,
  personDigest,
  personKey,
  statementOf,
  UNMATCHED,
  type HostStatement,
} from '@/lib/widget/person';
import {
  clearToken,
  readToken,
  readTokenPerson,
  writeToken,
  writeTokenPerson,
} from '@/lib/widget/token-store';
import { initialView } from '@/lib/widget/view';
import type { Message, WidgetView } from '@/lib/widget/types';

/**
 * How long a frame with a stored conversation waits for the host page to say
 * who is reading before deciding that it names nobody.
 *
 * Every copy of the snippet answers the frame's 'hello' as it arrives, so the
 * wait ends in a round trip on every real host page; this is the bound for a
 * frame nobody answers, which then resumes only a conversation that was never
 * vouched for as anybody's. Generous, because the cost of running out is a
 * returning merchant refused their own conversation on a host whose main
 * thread was busy.
 */
const HOST_STATEMENT_WAIT_MS = 3_000;

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

  // --- Who the host page says is reading ------------------------------------

  /** The latest statement heard, or null before the first. */
  const heard = useRef<{ stated: HostStatement } | null>(null);
  /** Which statement is the latest, since each digest settles asynchronously. */
  const hearing = useRef(0);
  const firstWord = useRef<Promise<HostStatement> | null>(null);
  const settleFirstWord = useRef<((stated: HostStatement) => void) | null>(null);

  /**
   * The host page's word on who is reading, from the `person` on its
   * `opened` and `closed` (`lib/widget/protocol.ts`). `carried` is whether the
   * message had the property at all: a snippet older than the field sends
   * none, which is "does not say" rather than "nobody".
   */
  const hearHost = useCallback((person: unknown, carried: boolean) => {
    const turn = ++hearing.current;
    void statementOf(person, carried).then((stated) => {
      // An earlier statement whose digest settles late must not overwrite a
      // newer one: after `clear()` the page names nobody, then the next person.
      if (turn !== hearing.current) return;
      heard.current = { stated };
      settleFirstWord.current?.(stated);
    });
  }, []);

  /** The latest statement, waiting for the first if none has been heard yet. */
  const hostStatement = useCallback((): Promise<HostStatement> => {
    if (heard.current) return Promise.resolve(heard.current.stated);
    firstWord.current ??= new Promise<HostStatement>((resolve) => {
      // Not framed by anything, so nothing will ever say.
      if (window.parent === window) {
        resolve(null);
        return;
      }
      settleFirstWord.current = resolve;
      setTimeout(() => resolve(null), HOST_STATEMENT_WAIT_MS);
    });
    return firstWord.current;
  }, []);

  /**
   * The stored token, if it is this visitor's to reopen; otherwise it is thrown
   * away and the answer is null, before anything has been asked of the server
   * about it. `lib/widget/person.ts` is the rule and says why it is decided
   * here, at the next open, rather than trusted to a sign-out.
   *
   * Nothing stored is answered at once, so a first-time visitor pressing the
   * button waits for nobody.
   */
  const allowedStoredToken = useCallback(async (): Promise<string | null> => {
    if (!readToken()) return null;
    const stated = await hostStatement();
    const stored = readToken();
    if (!stored) return null;
    if (mayResume(stated, readTokenPerson(stored))) return stored;
    clearToken();
    return null;
  }, [hostStatement]);

  // --- Session -------------------------------------------------------------

  /*
   * Resumed on load, but never minted there, and only after the host page has
   * said who is reading.
   *
   * `POST /api/widget/session` writes a `contacts` row for a token it does not
   * recognise, so calling it on every load would file a customer record for
   * everyone who opened the panel to read an FAQ and left. The same rule the
   * tracking lookup follows: an unauthenticated read never writes a row, or the
   * table becomes a place anyone can put things. A visitor becomes a contact at
   * the moment they choose to talk to somebody, which is `ensureSession` below.
   *
   * The wait comes first because the request is the leak: it returns the
   * stored conversation, and the thread draws it. Resumed on mount as this
   * used to be, the next merchant at a shared machine was shown the previous
   * one's chat before anything had said who was reading.
   */
  useEffect(() => {
    if (!readToken()) return;

    void allowedStoredToken()
      .then((stored) =>
        stored
          ? fetch('/api/widget/session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: stored }),
            }).then((response) => (response.ok ? response.json() : null))
          : null,
      )
      .then((data) => {
        if (!data) return;
        writeToken(data.token);
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
  }, [activeTokenRef, allowedStoredToken, navigatedRef, seenCountRef, setThreadStarted, setView]);

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
   * being overwritten — and through the same check the resume makes, so a
   * visitor who presses the button before it has finished cannot reopen what
   * it would have refused.
   */
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (token) return token;
    if (minting.current) return minting.current;

    const request = (async () => {
      const stored = (await allowedStoredToken()) ?? '';

      const data = await fetch('/api/widget/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: stored }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);

      if (!data) return null;

      writeToken(data.token);
      // Vouched for at once when the page has said who is reading, so a token
      // whose identify never gets through is still refused to somebody else.
      const stated = heard.current?.stated;
      if (typeof stated === 'string' && stated !== UNMATCHED) writeTokenPerson(data.token, stated);
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
  }, [token, activeTokenRef, allowedStoredToken]);

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
    clearToken();
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
      // A token replaced since this was asked for: the next person's details
      // must not be written onto the previous session's contact.
      if (activeTokenRef.current !== forToken) return;

      /*
       * The person check again, for a page that says who is reading only
       * through `identify()`: a snippet older than the `person` field, or a
       * page whose visitor changed without a reload. A token vouched for as
       * somebody else is thrown away before the server is told anything;
       * otherwise it is vouched for as this person, ahead of the request, so a
       * failed identify still leaves it refused to the next one.
       */
      const digest = await personDigest(personKey(pending.identity));
      if (activeTokenRef.current !== forToken) return;
      if (digest) {
        const recorded = readTokenPerson(forToken);
        if (recorded && recorded !== digest) {
          startFreshSession();
          return;
        }
        writeTokenPerson(forToken, digest);
      }

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

      // Sent again on the next 'ready' or the host page's next identify()
      // rather than left unsaid: the fingerprint is what makes the common case
      // free, and keeping it after a failure would cost the agent the
      // customer's name for the rest of the session.
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
    [activeTokenRef, identityRef, resetsRef, startFreshSession],
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
    hearHost,
  };
}
