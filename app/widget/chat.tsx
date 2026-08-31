'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { direction, type Locale } from '@/lib/kb/locale';
import { initialView } from '@/lib/widget/view';
import { WidgetArticle } from './article';
import { copyFor } from './copy';
import { WidgetHome } from './home';
import { WidgetThread, type OfflineDetails } from './thread';
import type { ArticleLink, Message, WidgetView } from './types';

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
  faqs,
  online,
  opensAt,
}: {
  locale: Locale;
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

  const [panelOpen, setPanelOpen] = useState(true);
  const [detailsSaved, setDetailsSaved] = useState(false);

  const seenCount = useRef(0);

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
        setToken(data.token);
        setConversationId(data.conversationId);
        setMessages(data.messages);
        setDetailsSaved(Boolean(data.detailsSaved));
        seenCount.current = data.messages.filter((m: Message) => m.from === 'agent').length;
        // A visitor coming back to a live conversation wants the reply they came
        // back for, not the FAQ list.
        const opening = initialView({ messageCount: data.messages.length });
        setThreadStarted(opening === 'thread');
        setView(opening);
      })
      .catch(() => {
        // Leaves the home screen up, which is rendered from props and needs
        // nothing from this call.
      });
  }, []);

  /** The token, minting one on first use. Resolves null only if the server did. */
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (token) return token;

    const data = await fetch('/api/widget/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '' }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);

    if (!data) return null;

    localStorage.setItem(STORAGE_KEY, data.token);
    setToken(data.token);
    setConversationId(data.conversationId);
    setMessages(data.messages);
    setDetailsSaved(Boolean(data.detailsSaved));
    return data.token as string;
  }, [token]);

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
          if (data) {
            setConversationId(data.conversationId);
            setMessages(data.messages);
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
    window.parent?.postMessage({ source: 'shipblu-widget', ...message }, '*');
  }, []);

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
    postToHost({ type: 'unread', count: Math.max(0, replies - seenCount.current) });
  }, [messages, view, panelOpen, postToHost]);

  useEffect(() => {
    const onHostMessage = (event: MessageEvent) => {
      if (event.data?.source !== 'shipblu-host') return;
      if (event.data.type === 'opened') setPanelOpen(true);
      if (event.data.type === 'closed') setPanelOpen(false);
    };

    window.addEventListener('message', onHostMessage);
    return () => window.removeEventListener('message', onHostMessage);
  }, []);

  // --- Navigation ----------------------------------------------------------

  // Only ever called from the home screen or from the thread's suggestion strip,
  // so the current view is the one to come back to.
  const openArticle = useCallback(
    (next: ArticleLink) => {
      setArticle(next);
      setArticleFrom(view === 'article' ? 'home' : view);
      setView('article');
    },
    [view],
  );

  /** Back goes where the visitor came from, which is not always the home screen. */
  const back = useCallback(() => {
    setView((current) => (current === 'article' ? articleFrom : 'home'));
  }, [articleFrom]);

  const talkToAgent = useCallback(() => {
    // Shown immediately; the token is minted underneath. Waiting for the round
    // trip would make the one button on the screen feel broken.
    setThreadStarted(true);
    setView('thread');
    void ensureSession();
  }, [ensureSession]);

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
          onClick={() => postToHost({ type: 'close' })}
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
        <WidgetArticle
          locale={locale}
          copy={copy}
          article={article}
          onBack={back}
          onTalkToAgent={talkToAgent}
        />
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
            detailsSaved={detailsSaved}
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
    timeZone: 'Africa/Cairo',
  }).format(new Date(iso));
}
