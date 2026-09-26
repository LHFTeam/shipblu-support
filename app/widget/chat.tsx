'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { direction, type Locale } from '@/lib/kb/locale';
import { HOST_SAYS, SOURCE, WIDGET_SAYS } from '@/lib/widget/protocol';
import { initialView } from '@/lib/widget/view';
import { WidgetArticle } from './article';
import { copyFor } from './copy';
import { WidgetHome } from './home';
import { WidgetThread, type OfflineDetails } from './thread';
import type { ArticleLink, Message, WidgetView } from '@/lib/widget/types';
import { TEAM_TIME_ZONE } from '@/lib/hours/zone';

/**
 * The widget shell: which screen is showing, and everything that outlives one.
 *
 * State lives here rather than on the server because the widget must feel
 * instant on a page the visitor is only half paying attention to: their own
 * message appears the moment they send it, and reconciles when the server
 * answers. The FAQ list and the business hours are the exception — they are
 * rendered by `page.tsx` and arrive as props, so the panel paints with answers
 * already in it rather than with a spinner.
 */

const STORAGE_KEY = 'shipblu.widget.token';

export function WidgetChat({
  locale,
  hostOrigins,
  faqs,
  online: initialOnline,
  opensAt: initialOpensAt,
}: {
  locale: Locale;
  /** Origins permitted to embed this widget, from `WIDGET_ALLOWED_ORIGINS`. */
  hostOrigins: string[];
  faqs: ArticleLink[];
  online: boolean;
  opensAt: string | null;
}) {
  const copy = copyFor(locale);

  const [view, setView] = useState<WidgetView>('home');
  const [article, setArticle] = useState<ArticleLink | null>(null);
  /* Where the article was opened from, so Back returns there rather than always
     to the home screen — a suggestion tapped mid-conversation has to lead back
     to the conversation. */
  const [articleFrom, setArticleFrom] = useState<WidgetView>('home');
  /* Once entered, the thread stays mounted (see the render). */
  const [threadStarted, setThreadStarted] = useState(false);

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

  const [panelOpen, setPanelOpen] = useState(true);
  const [detailsSaved, setDetailsSaved] = useState(false);
  /*
   * Text a host page asked us to start the visitor off with, and a sequence
   * number rather than a bare string.
   *
   * The thread applies a prefill it has not seen before, so the counter is what
   * lets the same host page hand over the same draft twice — a visitor pressing
   * "ask support about this shipment" again after clearing the box — without
   * either press being mistaken for a repaint of the other.
   */
  const [prefill, setPrefill] = useState<{ text: string; seq: number } | null>(null);

  const seenCount = useRef(0);
  /* One session request at a time. Without this, `talkToAgent` firing one and a
     fast Send firing another both see `token` still null and both POST an empty
     token — which the route answers by minting a *second* contact, filing the
     message against whichever won, and orphaning the other. */
  const minting = useRef<Promise<string | null> | null>(null);
  /**
   * The token the visible transcript belongs to, updated at the two moments it
   * changes rather than in an effect.
   *
   * In-flight requests read it back before they paint. A send that was still on
   * the wire when the host page signed its user out would otherwise answer into
   * the session that replaced it, putting the previous person's messages in
   * front of the next one — the exact leak the reset exists to prevent.
   */
  const activeToken = useRef<string | null>(null);
  /** The last identity the host page handed us, and its signature. */
  const identity = useRef<{ identity: unknown; signature: string | null } | null>(null);
  /** `token:payload` of the last identity actually sent, so opens are cheap. */
  const identified = useRef<string | null>(null);
  /**
   * How many times the server has told us this browser belongs to somebody
   * else. Bounded because the answer costs a session round trip, and a bug on
   * either side that made it permanent would otherwise loop forever against the
   * API rather than failing visibly.
   */
  const resets = useRef(0);
  /* Whether the visitor has navigated since mount. The resume request settles
     after they may already have tapped something, and it must not drag them
     back out of it. */
  const navigated = useRef(false);
  /* Which prefill this is, so a repeat of the same text is still a new one. */
  const composeSeq = useRef(0);

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
        activeToken.current = data.token;
        setToken(data.token);
        setConversationId(data.conversationId);
        setMessages(data.messages);
        setDetailsSaved(Boolean(data.detailsSaved));
        setOnline(Boolean(data.online));
        setOpensAt((data.opensAt as string | null) ?? null);
        seenCount.current = data.messages.filter((m: Message) => m.from === 'agent').length;
        // A visitor coming back to a live conversation wants the reply they came
        // back for, not the FAQ list.
        // Only if they have not already chosen a screen while this was in
        // flight — otherwise a slow resume yanks a visitor out of the article
        // they opened, or unmounts the thread they are typing into.
        if (!navigated.current) {
          const opening = initialView({ messageCount: data.messages.length });
          if (opening === 'thread') setThreadStarted(true);
          setView(opening);
        }
      })
      .catch(() => {
        // Leaves the home screen up, which is rendered from props and needs
        // nothing from this call.
      });
  }, []);

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
      activeToken.current = data.token;
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
  }, [token]);

  /**
   * The visitor has chosen to talk. Lives here rather than under Navigation
   * because minting is the part that matters: this is the moment a browser
   * becomes a `contacts` row, and the screen change is the cheap half.
   */
  const talkToAgent = useCallback(() => {
    // Shown immediately; the token is minted underneath. Waiting for the round
    // trip would make the one button on the screen feel broken.
    navigated.current = true;
    setThreadStarted(true);
    setView('thread');
    void ensureSession();
  }, [ensureSession]);

  /**
   * The same thing, with the host page's own subject already in the box.
   *
   * Choosing to talk is what this is — the tracking page's support button, not
   * a page load — so it mints exactly as the button on the home screen does. It
   * only ever *drafts*: the widget stops at the composer and the visitor sends,
   * because a host page that could put words in somebody's mouth would be a
   * page that can open a ticket in their name.
   */
  const compose = useCallback(
    (text: string) => {
      composeSeq.current += 1;
      setPrefill({ text, seq: composeSeq.current });
      talkToAgent();
    },
    [talkToAgent],
  );

  // --- Live agent replies --------------------------------------------------

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
          // Same reason as the guard in `send`: the interval is cleared when
          // the token changes, but a request already issued still resolves, and
          // painting its answer would put the previous person's transcript in
          // front of the next one.
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
  }, [token, conversationId]);

  // --- Unread badge on the host page ---------------------------------------

  const postToHost = useCallback((message: Record<string, unknown>) => {
    // '*' is correct here and only here: the widget does not know which origin
    // embedded it, and the payload carries nothing secret — an unread count.
    // The host's listener checks *our* origin, which is the half that matters.
    window.parent?.postMessage({ source: SOURCE.widget, ...message }, '*');
  }, []);

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
    activeToken.current = null;
    identified.current = null;
    seenCount.current = 0;
    setToken(null);
    setConversationId(null);
    setMessages([]);
    setDetailsSaved(false);
    setThreadStarted(false);
    setView('home');
  }, []);

  const sendIdentity = useCallback(
    async (forToken: string) => {
      const pending = identity.current;
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
      if (data?.reset && resets.current < 2) {
        resets.current += 1;
        startFreshSession();
      }
    },
    [startFreshSession],
  );

  /*
   * Announced when a token exists, which is now later than it used to be: the
   * widget opens on the questions and mints nothing until somebody chooses to
   * talk. So an identity the host pushes at load is held in the ref above and
   * attached here, on the first token — rather than the host having to re-send
   * it at the moment the visitor happens to press the button.
   */
  useEffect(() => {
    if (!token) return;
    postToHost({ type: WIDGET_SAYS.ready });
    void sendIdentity(token);
  }, [token, postToHost, sendIdentity]);

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
    if (panelOpen && view === 'thread') seenCount.current = replies;
    postToHost({ type: WIDGET_SAYS.unread, count: Math.max(0, replies - seenCount.current) });
  }, [messages, view, panelOpen, postToHost]);

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
        identity.current = {
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
        identity.current = null;
        resets.current = 0;
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
  }, [compose, hostOrigins, postToHost, sendIdentity, startFreshSession, token]);

  // --- Navigation ----------------------------------------------------------

  // Only ever called from the home screen or from the thread's suggestion strip,
  // so the current view is the one to come back to.
  const openArticle = useCallback(
    (next: ArticleLink) => {
      navigated.current = true;
      setArticle(next);
      setArticleFrom(view === 'article' ? 'home' : view);
      setView('article');
    },
    [view],
  );

  /** Back goes where the visitor came from, which is not always the home screen. */
  const back = useCallback(() => {
    navigated.current = true;
    setView((current) => (current === 'article' ? articleFrom : 'home'));
  }, [articleFrom]);

  // --- Sending -------------------------------------------------------------

  /** Files how to reach the visitor. Needs a conversation, so never called first. */
  const saveDetails = useCallback(
    async (activeToken: string, details: OfflineDetails): Promise<boolean> => {
      if (!details.email.trim() && !details.phone.trim()) return false;

      const ok = await fetch('/api/widget/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: activeToken, ...details }),
      })
        .then((response) => response.ok)
        .catch(() => false);

      if (ok) setDetailsSaved(true);
      return ok;
    },
    [],
  );

  async function send(body: string, details: OfflineDetails | null): Promise<boolean> {
    const active = await ensureSession();
    if (!active) return false;

    // Shown immediately with a temporary id, then replaced by the server's
    // canonical list. Waiting for the round trip makes the widget feel broken
    // on a slow connection.
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      from: 'visitor',
      authorName: null,
      body,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);

    try {
      const response = await fetch('/api/widget/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: active, body, pageUrl: document.referrer || null }),
      });

      /*
       * The session was replaced while this was on the wire — a sign-out on the
       * host page. Everything below belongs to somebody who is no longer here,
       * the draft included: putting that text back would hand the next person
       * the previous one's half-typed sentence, so this reports success it did
       * not have rather than restoring it.
       */
      if (activeToken.current !== active) return true;

      if (!response.ok) {
        setMessages((current) => current.filter((m) => m.id !== optimistic.id));
        return false;
      }

      const data = (await response.json()) as { conversationId: string; messages: Message[] };
      setConversationId(data.conversationId);
      setMessages(data.messages);
      seenCount.current = data.messages.filter((m) => m.from === 'agent').length;

      /*
       * The details go second, because they need the conversation this message
       * just opened — `/api/widget/contact` writes a timeline event, and an
       * event has nowhere to hang without one.
       *
       * Its failure does not fail the send: the message is stored either way,
       * and throwing away what the visitor wrote because we could not file a
       * phone number would be the worse of the two losses. The form stays up
       * instead, with its own button, so the number is recoverable rather than
       * quietly gone.
       */
      if (details) await saveDetails(active, details);

      return true;
    } catch {
      setMessages((current) => current.filter((m) => m.id !== optimistic.id));
      return false;
    }
  }

  // --- Chrome --------------------------------------------------------------

  const showBack = view !== 'home';

  return (
    <div dir={direction(locale)} lang={locale} className="flex h-full flex-col text-sm">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        {showBack ? (
          <button
            type="button"
            onClick={back}
            aria-label={copy.back}
            /* A logical arrow: `rtl` flips the glyph with the layout, so this
               points back in both languages rather than forward in one. */
            className="-ms-2 rounded px-2 py-1 opacity-60 hover:opacity-100 rtl:rotate-180"
          >
            ←
          </button>
        ) : null}

        <div className="min-w-0">
          <p className="font-semibold">{copy.heading}</p>
          <p className="truncate text-xs opacity-60">
            {online ? copy.online : copy.offline}
            {!online && opensAt ? ` · ${copy.opensAt} ${formatOpens(opensAt, locale)}` : ''}
          </p>
        </div>

        <button
          type="button"
          onClick={() => postToHost({ type: WIDGET_SAYS.close })}
          aria-label={copy.close}
          className="ms-auto rounded px-2 py-1 opacity-50 hover:opacity-100"
        >
          ✕
        </button>
      </header>

      {view === 'home' ? (
        <WidgetHome
          locale={locale}
          copy={copy}
          faqs={faqs}
          online={online}
          onOpenArticle={openArticle}
          onTalkToAgent={talkToAgent}
        />
      ) : null}

      {view === 'article' && article ? (
        <WidgetArticle locale={locale} copy={copy} article={article} onTalkToAgent={talkToAgent} />
      ) : null}

      {/*
        Hidden rather than unmounted, once it has been opened.
        Unmounting throws away the half-written message and the scroll position,
        which turns the suggestion strip above the composer into a trap: tapping
        an article to check something would delete the sentence that prompted it.
        `contents` keeps the thread a flex item of this column while it is up.
      */}
      {threadStarted ? (
        <div className={view === 'thread' ? 'contents' : 'hidden'}>
          <WidgetThread
            locale={locale}
            copy={copy}
            messages={messages}
            online={online}
            active={view === 'thread'}
            detailsSaved={detailsSaved}
            prefill={prefill}
            onSend={send}
            onSaveDetails={async (details) => {
              const active = await ensureSession();
              return active ? saveDetails(active, details) : false;
            }}
            onOpenArticle={openArticle}
          />
        </div>
      ) : null}
    </div>
  );
}

function formatOpens(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TEAM_TIME_ZONE,
  }).format(new Date(iso));
}
