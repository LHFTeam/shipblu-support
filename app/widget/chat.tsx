'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { direction, type Locale } from '@/lib/kb/locale';
import { WIDGET_SAYS } from '@/lib/widget/protocol';
import { WidgetArticle } from './article';
import { copyFor } from './copy';
import { WidgetHome } from './home';
import { WidgetThread, type OfflineDetails } from './thread';
import type { ArticleLink, Message, WidgetView } from '@/lib/widget/types';
import { TEAM_TIME_ZONE } from '@/lib/hours/zone';
import { postToHost, useHostBridge } from './use-host-bridge';
import { useMessageStream } from './use-message-stream';
import { useWidgetSession } from './use-widget-session';

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

  const [panelOpen, setPanelOpen] = useState(true);
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

  const {
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
  } = useWidgetSession({
    initialOnline,
    initialOpensAt,
    seenCountRef: seenCount,
    activeTokenRef: activeToken,
    identityRef: identity,
    resetsRef: resets,
    navigatedRef: navigated,
    setView,
    setThreadStarted,
  });

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

  useMessageStream({
    token,
    conversationId,
    activeToken,
    setConversationId,
    setMessages,
    setOnline,
    setOpensAt,
  });

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
  }, [token, sendIdentity]);

  // --- Unread badge, and what the host page says ---------------------------

  useHostBridge({
    hostOrigins,
    token,
    messages,
    view,
    panelOpen,
    setPanelOpen,
    seenCountRef: seenCount,
    identityRef: identity,
    resetsRef: resets,
    compose,
    sendIdentity,
    startFreshSession,
  });

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
    [setDetailsSaved],
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
