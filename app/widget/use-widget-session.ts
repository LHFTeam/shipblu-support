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
  judge,
  statementOf,
  type HostStatement,
  type Judgement,
  type PersonPrint,
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

/** The wait for the host page's first word: its promise, its timer and its resolver, together. */
type FirstWord = {
  promise: Promise<HostStatement>;
  settle: (stated: HostStatement) => void;
  timer?: ReturnType<typeof setTimeout>;
};

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

  /**
   * The latest statement, with a turn that moves on every one, so a decision
   * taken before a request can tell whether the page has spoken since.
   */
  const heard = useRef<{ stated: HostStatement; turn: number } | null>(null);
  /** Which statement is the latest, since each digest settles asynchronously. */
  const hearing = useRef(0);
  const firstWord = useRef<FirstWord | null>(null);
  /** How the open session's token came to be, reopened or minted here, which `judge` weighs. */
  const standing = useRef<{ token: string; how: 'resumed' | 'minted' } | null>(null);
  /** The resume, for a statement that arrives after a stored conversation was left waiting. */
  const resumeRef = useRef<() => void>(() => {});

  /**
   * The host page's word on who is reading: the `person` on its `opened` and
   * `closed`, or the identity on an `identify` (`lib/widget/protocol.ts`).
   * `carried` is whether the message had the property at all: a snippet older
   * than the field sends none, which is "does not say" rather than "nobody".
   *
   * One source for every path that asks who is reading, kept current by every
   * message that says, so the resume, the mint and the identity sent after
   * them cannot be deciding about three different people.
   */
  const hearHost = useCallback((person: unknown, carried: boolean) => {
    const turn = ++hearing.current;
    void statementOf(person, carried).then((stated) => {
      // An earlier statement whose digest settles late must not overwrite a
      // newer one: after `clear()` the page names nobody, then the next person.
      if (turn !== hearing.current) return;
      heard.current = { stated, turn };
      firstWord.current?.settle(stated);
      // A conversation left in storage for want of a word may be this reader's.
      resumeRef.current();
    });
  }, []);

  useEffect(() => () => clearTimeout(firstWord.current?.timer), []);

  /** The latest statement, waiting for the first if none has been heard yet. */
  const hostStatement = useCallback(async (): Promise<{ stated: HostStatement; turn: number }> => {
    if (heard.current) return heard.current;
    if (!firstWord.current) {
      let resolve: (stated: HostStatement) => void = () => {};
      const promise = new Promise<HostStatement>((done) => {
        resolve = done;
      });
      const wait: FirstWord = {
        promise,
        settle: (stated) => {
          clearTimeout(wait.timer);
          wait.settle = () => {};
          resolve(stated);
        },
      };
      firstWord.current = wait;
      // Not framed by anything, so nothing will ever say.
      if (window.parent === window) wait.settle(null);
      else wait.timer = setTimeout(() => wait.settle(null), HOST_STATEMENT_WAIT_MS);
    }
    const stated = await firstWord.current.promise;
    // Turn 0 when the wait ran out: any statement after it is newer.
    return heard.current ?? { stated, turn: 0 };
  }, []);

  /**
   * The stored token and what the page's latest word makes of it
   * (`lib/widget/person.ts`), decided before anything has been asked of the
   * server about it. A token the page names somebody else for is thrown away
   * here; one it names nobody for, or says less about, is left where it is.
   *
   * Nothing stored is answered at once, so a first-time visitor pressing the
   * button waits for nobody.
   */
  const judgeStored = useCallback(async () => {
    if (!readToken()) return null;
    const { stated, turn } = await hostStatement();
    const stored = readToken();
    if (!stored) return null;
    const judgement = judge(stated, readTokenPerson(stored), 'stored');
    if (judgement.verdict === 'discard') clearToken();
    return { stored, turn, judgement };
  }, [hostStatement]);

  /**
   * What to record once a request for a reopened token is back — or null when
   * the page has named somebody since who may not have it, in which case it is
   * not drawn. The request returns the conversation, so the decision is taken
   * again if the page spoke while it was in flight.
   */
  const stillOpen = useCallback(
    (decision: { stored: string; turn: number; judgement: Judgement }): Judgement | null => {
      if (!heard.current || heard.current.turn === decision.turn) return decision.judgement;
      const judgement = judge(heard.current.stated, readTokenPerson(decision.stored), 'stored');
      if (judgement.verdict === 'discard') clearToken();
      return judgement.verdict === 'open' ? judgement : null;
    },
    [],
  );

  /** What a token minted now is vouched for as: whoever the page says is reading. */
  const mintedRecord = (): PersonPrint | null =>
    judge(heard.current?.stated, null, 'minted').record;

  // --- Session -------------------------------------------------------------

  /** One session request, null on any failure: the callers decide what nothing means. */
  const postSession = (sessionToken: string) =>
    fetch('/api/widget/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sessionToken }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);

  /** A session the server answered, made the open one, and recorded as `record` if given. */
  const adopt = (
    data: {
      token: string;
      conversationId: string | null;
      messages: Message[];
      detailsSaved?: unknown;
      online?: unknown;
      opensAt?: unknown;
    },
    how: 'resumed' | 'minted',
    record: PersonPrint | null,
  ) => {
    writeToken(data.token);
    if (record) writeTokenPerson(data.token, record);
    standing.current = { token: data.token, how };
    activeTokenRef.current = data.token;
    setToken(data.token);
    setConversationId(data.conversationId);
    setMessages(data.messages);
    setDetailsSaved(Boolean(data.detailsSaved));
    setOnline(Boolean(data.online));
    setOpensAt((data.opensAt as string | null) ?? null);
  };

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
  const resuming = useRef(false);
  const resumeStored = useCallback(() => {
    // Not while a session is open or being opened: whether it is still this
    // reader's is `sendIdentity`'s question.
    if (resuming.current || minting.current || activeTokenRef.current || !readToken()) return;
    resuming.current = true;

    void (async () => {
      try {
        const decision = await judgeStored();
        if (!decision || decision.judgement.verdict !== 'open') return;

        const data = await postSession(decision.stored);
        if (!data || activeTokenRef.current || minting.current) return;
        const judgement = stillOpen(decision);
        if (!judgement) return;

        // The server answers a token it does not recognise with a new one,
        // minted for this reader, and recorded for them as a mint is.
        const replaced = data.token !== decision.stored;
        adopt(data, replaced ? 'minted' : 'resumed', replaced ? mintedRecord() : judgement.record);
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
      } catch {
        // Leaves the home screen up, which is rendered from props and needs
        // nothing from this call.
      } finally {
        resuming.current = false;
      }
    })();
    // `adopt` and `mintedRecord` read only refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTokenRef,
    judgeStored,
    navigatedRef,
    seenCountRef,
    setThreadStarted,
    setView,
    stillOpen,
  ]);

  useEffect(() => {
    resumeRef.current = resumeStored;
    resumeStored();
  }, [resumeStored]);

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
      const decision = await judgeStored();
      const admitted = decision?.judgement.verdict === 'open' ? decision : null;

      let data = await postSession(admitted?.stored ?? '');
      if (!data) return null;

      if (admitted && data.token === admitted.stored) {
        const judgement = stillOpen(admitted);
        if (judgement) {
          adopt(data, 'resumed', judgement.record);
          return data.token as string;
        }
        // The page named somebody else while this was in flight: a session of
        // their own, not the conversation that was just refused them.
        data = await postSession('');
        if (!data) return null;
      }

      // Vouched for at once when the page has said who is reading, so a token
      // whose identify never gets through is still refused to somebody else.
      adopt(data, 'minted', mintedRecord());
      return data.token as string;
    })();

    minting.current = request;
    try {
      return await request;
    } finally {
      minting.current = null;
    }
    // `adopt` and `mintedRecord` read only refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, judgeStored, stillOpen]);

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
    standing.current = null;
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
       * The person check on the open session, through the same `judge` the
       * resume asks: for a snippet older than the `person` field, which says
       * who is reading only here, and for a page whose visitor changed without
       * a reload. A session vouched for as somebody else is thrown away before
       * the server is told anything. Otherwise it is vouched for as this
       * person, ahead of the request, so a failed identify still leaves it
       * refused to the next one, and a field the page has added since is
       * added to the record rather than read as a different person.
       */
      const stated = await statementOf(pending.identity, true);
      if (activeTokenRef.current !== forToken) return;
      const how = standing.current?.token === forToken ? standing.current.how : 'resumed';
      const judgement = judge(stated, readTokenPerson(forToken), how);
      if (judgement.verdict !== 'open') {
        startFreshSession();
        return;
      }
      if (judgement.record) writeTokenPerson(forToken, judgement.record);

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
