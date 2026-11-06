'use client';

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ShipBluLogo } from '@/components/brand';
import { ChevronLeftIcon, XIcon } from '@/components/icons';
import { direction, type Locale } from '@/lib/kb/locale';
import { WIDGET_SAYS } from '@/lib/widget/protocol';
import { WidgetArticle } from './article';
import { copyFor } from './copy';
import { WidgetHome } from './home';
import type { SurveyResult } from './survey-card';
import { WidgetThread, type OfflineDetails, type SendOutcome, type SendRefusal } from './thread';
import type { ArticleLink, Message, WidgetView } from '@/lib/widget/types';
import { formatOpens } from '@/lib/format';
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
    hearHost,
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

  /*
   * The visitor's sends still on the wire, each with the session it was sent
   * in. A list from the server replaces the transcript whole, and until a send
   * is stored it is in no list the server has: a push or a poll while a video
   * uploaded took the visitor's message off the screen, with the composer
   * already empty, so it read as lost and was attached again. So every list
   * from the server is drawn with these after it — only for the session that
   * sent them, or a sign-out on the host page would hand the next person the
   * previous one's message.
   */
  const unsettled = useRef(new Map<string, Unsettled>());

  /*
   * A list read after the send was stored already holds it, under the id the
   * server gave it, and the POST that says so can still be running the
   * automations: one the transcript did not hold when the send began, from
   * the visitor, with the same words and as many files, is that send.
   */
  const withUnsettled = useCallback((list: Message[]) => {
    const mine = [...unsettled.current.values()].filter(
      (entry) =>
        entry.token === activeToken.current &&
        !list.some(
          (message) =>
            message.from === 'visitor' &&
            !entry.before.has(message.id) &&
            message.body === entry.message.body &&
            (message.attachments ?? []).length === (entry.message.attachments ?? []).length,
        ),
    );
    return mine.length > 0 ? [...list, ...mine.map((entry) => entry.message)] : list;
  }, []);

  const setServerMessages = useCallback<Dispatch<SetStateAction<Message[]>>>(
    (next) =>
      setMessages((current) => withUnsettled(typeof next === 'function' ? next(current) : next)),
    [setMessages, withUnsettled],
  );

  useMessageStream({
    token,
    conversationId,
    activeToken,
    setConversationId,
    setMessages: setServerMessages,
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
    hearHost,
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

  async function send(
    body: string,
    files: File[],
    details: OfflineDetails | null,
  ): Promise<SendOutcome> {
    const active = await ensureSession();
    if (!active) return FAILED;

    // Shown immediately with a temporary id, then replaced by the server's
    // canonical list. Waiting for the round trip makes the widget feel broken
    // on a slow connection — and a photo or a video takes longer than words.
    const pendingId = `pending-${Date.now()}`;
    const optimistic: Message = {
      id: pendingId,
      from: 'visitor',
      authorName: null,
      body,
      createdAt: new Date().toISOString(),
      survey: null,
      attachments: files.map((file, index) => ({
        id: `${pendingId}-${index}`,
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        // Nothing stored to fetch yet: drawn as its name until the server answers.
        url: null,
      })),
    };
    unsettled.current.set(pendingId, {
      token: active,
      message: optimistic,
      before: new Set(messages.map((message) => message.id)),
    });
    setMessages((current) => [...current, optimistic]);

    try {
      const pageUrl = document.referrer || null;
      const response = await fetch(
        '/api/widget/message',
        messageRequest(active, body, pageUrl, locale, files),
      );

      /*
       * The session was replaced while this was on the wire — a sign-out on the
       * host page. Everything below belongs to somebody who is no longer here,
       * the draft included: putting that text back would hand the next person
       * the previous one's half-typed sentence, so this reports success it did
       * not have rather than restoring it.
       */
      if (activeToken.current !== active) return { ok: true };

      if (!response.ok) {
        setMessages((current) => current.filter((m) => m.id !== optimistic.id));
        return { ok: false, refusal: await refusalOf(response) };
      }

      const data = (await response.json()) as { conversationId: string; messages: Message[] };
      unsettled.current.delete(pendingId);
      setConversationId(data.conversationId);
      setServerMessages(data.messages);
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

      return { ok: true };
    } catch {
      setMessages((current) => current.filter((m) => m.id !== optimistic.id));
      return FAILED;
    } finally {
      unsettled.current.delete(pendingId);
    }
  }

  /**
   * An answer from a survey card, for the session whose transcript drew it —
   * the ref, not `ensureSession`, because a card is only ever on screen once a
   * session is. The rating the survey holds afterwards, null when there was
   * nothing to answer, or false when it did not go through — including a
   * session replaced while it was on the wire, whose card is the previous
   * person's and is about to go.
   */
  const answerSurvey = useCallback(
    async (surveyId: string, rating: number, comment: string | null): Promise<SurveyResult> => {
      const active = activeToken.current;
      if (!active) return false;

      try {
        const response = await fetch('/api/widget/csat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: active, surveyId, rating, comment }),
        });
        if (!response.ok || activeToken.current !== active) return false;
        const data = (await response.json()) as { rating?: unknown };
        return typeof data.rating === 'number' ? data.rating : null;
      } catch {
        return false;
      }
    },
    [],
  );

  // --- Chrome --------------------------------------------------------------

  const showBack = view !== 'home';

  return (
    <div
      dir={direction(locale)}
      lang={locale}
      className="flex h-full flex-col bg-(--color-background-surface) text-sm text-(--color-text-primary)"
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-(--color-border-subtle) px-3.5 py-3">
        {showBack ? (
          <button
            type="button"
            onClick={back}
            aria-label={copy.back}
            className={`-ms-1.5 ${HEADER_BUTTON}`}
          >
            {/* Mirrors itself in Arabic, so it points back in both languages. */}
            <ChevronLeftIcon size={18} />
          </button>
        ) : (
          <ShipBluLogo className="size-8" />
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm leading-5 font-semibold">{copy.heading}</p>
          {/* The word is always there, so the green is never the only thing
              saying whether we are open. */}
          <p
            className={`flex items-center gap-1.5 text-xs leading-4 ${
              online ? 'text-(--color-feedback-success-fg)' : 'text-(--color-text-secondary)'
            }`}
          >
            {online ? (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
            ) : null}
            {/* Wraps rather than truncates: offline, the end of this line is
                when we reopen, which is the one thing the visitor needs. */}
            <span>
              {online ? copy.online : copy.offline}
              {!online && opensAt ? ` · ${copy.opensAt} ${formatOpens(opensAt, locale)}` : ''}
            </span>
          </p>
        </div>

        <button
          type="button"
          onClick={() => postToHost({ type: WIDGET_SAYS.close })}
          aria-label={copy.close}
          className={HEADER_BUTTON}
        >
          <XIcon size={18} />
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
            onAnswerSurvey={answerSurvey}
          />
        </div>
      ) : null}
    </div>
  );
}

const FAILED: SendOutcome = { ok: false, refusal: { reason: 'failed' } };

/** A send on the wire: whose session, what is drawn for it, and what the transcript held before. */
type Unsettled = { token: string; message: Message; before: ReadonlySet<string> };

/**
 * A text message as the JSON it has always been, and one with files as a
 * multipart body: the files ride in the message's own request, so a file can
 * never be stored without the message it came with. The browser writes the
 * multipart boundary into the `Content-Type` itself, which is why none is set.
 */
function messageRequest(
  token: string,
  body: string,
  pageUrl: string | null,
  /** The panel's language, which answers a message with no words in it (`requesterLocale`). */
  locale: Locale,
  files: readonly File[],
): RequestInit {
  if (files.length === 0) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, body, pageUrl, locale }),
    };
  }

  const form = new FormData();
  form.set('token', token);
  form.set('body', body);
  form.set('locale', locale);
  if (pageUrl) form.set('pageUrl', pageUrl);
  for (const file of files) form.append('files', file, file.name);
  return { method: 'POST', body: form };
}

/**
 * What a refused send was refused for, in the reasons the composer has words
 * for. A file's reason is the route's reading of the same rules the composer
 * applies (`lib/widget/files.ts`), so it only arrives here when the bytes
 * disagreed with the label; anything unrecognised — a dropped connection, the
 * per-minute message limit, a storage outage — is the plain "try again".
 */
async function refusalOf(response: Response): Promise<SendRefusal> {
  const data = (await response.json().catch(() => null)) as {
    error?: unknown;
    filename?: unknown;
  } | null;
  const filename = typeof data?.filename === 'string' ? data.filename : '';

  switch (data?.error) {
    case 'type':
      return { reason: 'type', filename };
    case 'too_large':
      return { reason: 'too_large', filename };
    case 'empty':
      return { reason: 'empty', filename };
    case 'too_large_total':
      return { reason: 'too_large_total' };
    case 'too_many':
      return { reason: 'too_many' };
    case 'slow_down':
      return { reason: 'slow_down' };
  }
  // A body over the limit can be refused before the route reads it, with
  // whatever a proxy in front of it says.
  return response.status === 413 ? { reason: 'too_large_total' } : { reason: 'failed' };
}

/* The design system's small ghost button, square: 32px around an 18px glyph. */
const HEADER_BUTTON =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-(--color-text-primary) transition-colors hover:bg-(--color-background-hover) active:bg-(--color-background-pressed)';
