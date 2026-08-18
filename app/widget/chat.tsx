'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { direction, type Locale } from '@/lib/kb/locale';

/**
 * The chat itself, running inside the widget iframe.
 *
 * State lives here rather than on the server because the widget must feel
 * instant on a page the visitor is only half paying attention to: their own
 * message appears the moment they send it, and reconciles when the server
 * answers.
 */

const STORAGE_KEY = 'shipblu.widget.token';

type Message = {
  id: string;
  from: 'visitor' | 'agent' | 'system';
  authorName: string | null;
  body: string;
  createdAt: string;
};

type Suggestion = { title: string; url: string };

const COPY = {
  en: {
    heading: 'ShipBlu Support',
    online: 'We usually reply in a few minutes',
    offline: 'We are away right now',
    opensAt: 'We reply from',
    placeholder: 'Type your message…',
    send: 'Send',
    emailPrompt: 'Leave your email and we will reply there.',
    emailPlaceholder: 'you@example.com',
    emailSaved: 'Thanks — we will email you.',
    suggested: 'These might help',
    starter: 'Ask us anything about your shipments.',
  },
  ar: {
    heading: 'دعم شيب بلو',
    online: 'نرد عادةً خلال دقائق',
    offline: 'لسنا متاحين الآن',
    opensAt: 'نرد ابتداءً من',
    placeholder: 'اكتب رسالتك…',
    send: 'إرسال',
    emailPrompt: 'اترك بريدك الإلكتروني وسنرد عليك هناك.',
    emailPlaceholder: 'you@example.com',
    emailSaved: 'شكرًا — سنراسلك عبر البريد.',
    suggested: 'قد تساعدك هذه المقالات',
    starter: 'اسألنا أي شيء عن شحناتك.',
  },
} as const;

export function WidgetChat({ locale }: { locale: Locale }) {
  const copy = COPY[locale];

  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [opensAt, setOpensAt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [emailSaved, setEmailSaved] = useState(false);

  const bottom = useRef<HTMLDivElement>(null);
  const seenCount = useRef(0);

  // --- Session -------------------------------------------------------------

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) ?? '';

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
        setMessages(data.messages);
        setOnline(data.online);
        setOpensAt(data.opensAt);
        seenCount.current = data.messages.length;
      })
      .catch(() => {
        // Leaves `online` null, which renders as the neutral header rather than
        // claiming either state.
      });
  }, []);

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
          if (data) setMessages(data.messages);
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
    } catch {
      startPolling();
    }

    return () => {
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [token]);

  // --- Unread badge on the host page ---------------------------------------

  const postToHost = useCallback((message: Record<string, unknown>) => {
    // '*' is correct here and only here: the widget does not know which origin
    // embedded it, and the payload carries nothing secret — an unread count.
    // The host's listener checks *our* origin, which is the half that matters.
    window.parent?.postMessage({ source: 'shipblu-widget', ...message }, '*');
  }, []);

  useEffect(() => {
    const unread = messages.filter((message) => message.from === 'agent').length;
    postToHost({ type: 'unread', count: Math.max(0, unread - seenCount.current) });
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, postToHost]);

  useEffect(() => {
    const onHostMessage = (event: MessageEvent) => {
      if (event.data?.source !== 'shipblu-host') return;
      if (event.data.type === 'opened') {
        seenCount.current = messages.length;
        postToHost({ type: 'unread', count: 0 });
      }
    };

    window.addEventListener('message', onHostMessage);
    return () => window.removeEventListener('message', onHostMessage);
  }, [messages, postToHost]);

  // --- Article suggestions -------------------------------------------------

  // Debounced so a suggestion query does not fire per keystroke. Short drafts
  // are filtered when rendering rather than by clearing state here — clearing
  // in the effect body is a synchronous setState that cascades a render.
  useEffect(() => {
    const query = draft.trim();
    if (query.length < 6) return;

    const timer = setTimeout(() => {
      void fetch(`/api/widget/search?q=${encodeURIComponent(query)}&locale=${locale}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => setSuggestions((data?.articles as Suggestion[]) ?? []))
        .catch(() => setSuggestions([]));
    }, 400);

    return () => clearTimeout(timer);
  }, [draft, locale]);

  // Derived, so a half-typed word hides the previous suggestions immediately
  // instead of leaving stale ones on screen until the next fetch settles.
  const visibleSuggestions = draft.trim().length < 6 ? [] : suggestions;

  // --- Sending -------------------------------------------------------------

  async function send(event: React.FormEvent) {
    event.preventDefault();

    const body = draft.trim();
    if (!body || !token || sending) return;

    setSending(true);
    setDraft('');
    setSuggestions([]);

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
        body: JSON.stringify({ token, body, pageUrl: document.referrer || null }),
      });

      if (response.ok) {
        const data = (await response.json()) as { messages: Message[] };
        setMessages(data.messages);
        seenCount.current = data.messages.filter((m) => m.from === 'agent').length;
      } else {
        // Put the text back rather than losing it.
        setMessages((current) => current.filter((m) => m.id !== optimistic.id));
        setDraft(body);
      }
    } catch {
      setMessages((current) => current.filter((m) => m.id !== optimistic.id));
      setDraft(body);
    } finally {
      setSending(false);
    }
  }

  async function saveEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const response = await fetch('/api/widget/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, email: form.get('email'), name: form.get('name') }),
    }).catch(() => null);

    if (response?.ok) setEmailSaved(true);
  }

  const showEmailPrompt = online === false && messages.length > 0 && !emailSaved;

  return (
    <div dir={direction(locale)} lang={locale} className="flex h-full flex-col text-sm">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <p className="font-semibold">{copy.heading}</p>
          <p className="truncate text-xs opacity-60">
            {online === null ? '' : online ? copy.online : copy.offline}
            {online === false && opensAt
              ? ` · ${copy.opensAt} ${formatOpens(opensAt, locale)}`
              : ''}
          </p>
        </div>

        <button
          type="button"
          onClick={() => postToHost({ type: 'close' })}
          aria-label="Close"
          className="ms-auto rounded px-2 py-1 opacity-50 hover:opacity-100"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm opacity-50">{copy.starter}</p>
        ) : null}

        <ol className="flex flex-col gap-2">
          {messages.map((message) => (
            <li
              key={message.id}
              className={`max-w-[85%] rounded-lg px-3 py-2 ${
                message.from === 'visitor' ? 'ms-auto bg-brand-600 text-white' : 'bg-[var(--muted)]'
              }`}
            >
              {message.from === 'agent' && message.authorName ? (
                <p className="mb-0.5 text-xs opacity-60">{message.authorName}</p>
              ) : null}
              <p className="whitespace-pre-wrap break-words">{message.body}</p>
            </li>
          ))}
        </ol>

        {showEmailPrompt ? (
          <form onSubmit={saveEmail} className="mt-4 rounded-lg border border-[var(--border)] p-3">
            <p className="mb-2 text-xs opacity-70">{copy.emailPrompt}</p>
            <div className="flex gap-2">
              <input
                name="email"
                type="email"
                required
                placeholder={copy.emailPlaceholder}
                className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm outline-none focus:border-brand-500"
              />
              <button
                type="submit"
                className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white"
              >
                {copy.send}
              </button>
            </div>
          </form>
        ) : null}

        {emailSaved ? (
          <p className="mt-4 rounded-lg bg-[var(--muted)] p-3 text-xs opacity-70">
            {copy.emailSaved}
          </p>
        ) : null}

        <div ref={bottom} />
      </div>

      {visibleSuggestions.length > 0 ? (
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-2">
          <p className="mb-1 text-xs opacity-50">{copy.suggested}</p>
          <ul className="flex flex-col gap-1">
            {visibleSuggestions.map((article) => (
              <li key={article.url}>
                <a
                  href={article.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-brand-600 underline underline-offset-2"
                >
                  {article.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        onSubmit={send}
        className="flex shrink-0 items-end gap-2 border-t border-[var(--border)] p-3"
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line — what every chat does,
            // and what a visitor will try without thinking.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(event);
            }
          }}
          rows={2}
          maxLength={5000}
          placeholder={copy.placeholder}
          disabled={!token}
          className="min-w-0 flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
        <button
          type="submit"
          disabled={!token || sending || !draft.trim()}
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {copy.send}
        </button>
      </form>
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
