'use client';

import { useEffect, useRef, useState } from 'react';
import type { Locale } from '@/lib/kb/locale';
import type { WidgetCopy } from './copy';
import type { ArticleLink, Message } from './types';

/**
 * The conversation itself.
 *
 * Reached by choosing it, from the home screen or from the bottom of an article
 * that did not answer the question — so by the time a visitor is here they have
 * decided to talk to somebody, and everything on screen is about getting their
 * message sent.
 */
export function WidgetThread({
  locale,
  copy,
  messages,
  online,
  detailsSaved,
  onSend,
  onSaveDetails,
  onOpenArticle,
}: {
  locale: Locale;
  copy: WidgetCopy;
  messages: Message[];
  online: boolean;
  detailsSaved: boolean;
  onSend: (body: string, details: OfflineDetails | null) => Promise<boolean>;
  onSaveDetails: (details: OfflineDetails) => Promise<boolean>;
  onOpenArticle: (article: ArticleLink) => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [suggestions, setSuggestions] = useState<ArticleLink[]>([]);
  const [details, setDetails] = useState<OfflineDetails>({ name: '', email: '', phone: '' });
  const [detailsError, setDetailsError] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);

  const bottom = useRef<HTMLDivElement>(null);

  /*
   * Out of hours, ask before the message rather than after it.
   *
   * The old prompt appeared once a message existed, which is the wrong order: a
   * visitor who typed at 2am and closed the tab had already gone by the time we
   * asked how to reach them. Asking first costs a field they can ignore and
   * turns the message into something answerable.
   *
   * It stays up until the details are actually stored, not until they are
   * typed — the write is a second request that can fail on its own, and silently
   * dropping a phone number the visitor believes they left is the one failure
   * this whole form exists to prevent.
   */
  const askForDetails = !online && !detailsSaved;

  /*
   * Which way they get sent. Before the first message there is no conversation
   * for `/api/widget/contact` to hang its timeline event on, so the details ride
   * along with the message; afterwards they need a button of their own, or a
   * failed write could only be retried by writing another message.
   */
  const started = messages.some((message) => message.from === 'visitor');

  async function saveDetails() {
    if (!details.email.trim() && !details.phone.trim()) {
      setDetailsError(true);
      return;
    }
    setDetailsError(false);
    setSavingDetails(true);
    await onSaveDetails(details);
    setSavingDetails(false);
  }

  // --- Article suggestions, mid-typing ------------------------------------

  useEffect(() => {
    const query = draft.trim();
    if (query.length < 6) return;

    const timer = setTimeout(() => {
      void fetch(`/api/widget/search?q=${encodeURIComponent(query)}&locale=${locale}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => setSuggestions(((data?.articles as ArticleLink[]) ?? []).slice(0, 3)))
        .catch(() => setSuggestions([]));
    }, 400);

    return () => clearTimeout(timer);
  }, [draft, locale]);

  // Derived, so a half-typed word hides the previous suggestions immediately
  // instead of leaving stale ones on screen until the next fetch settles.
  const visibleSuggestions = draft.trim().length < 6 ? [] : suggestions;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const body = draft.trim();
    if (!body || sending) return;

    // Only enforced while the details are travelling with the message. Once
    // there is a conversation they have their own button, and blocking a reply
    // on them would trap a visitor inside a form.
    if (askForDetails && !started && !details.email.trim() && !details.phone.trim()) {
      setDetailsError(true);
      return;
    }

    setSending(true);
    setDetailsError(false);
    setDraft('');
    setSuggestions([]);

    const sent = await onSend(body, askForDetails && !started ? details : null);
    // Put the text back rather than losing it.
    if (!sent) setDraft(body);
    setSending(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !askForDetails ? (
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

        <div ref={bottom} />
      </div>

      {askForDetails ? (
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-3">
          <p className="mb-2 text-xs opacity-70">{copy.detailsPrompt}</p>
          <div className="flex flex-col gap-2">
            <input
              name="name"
              value={details.name}
              onChange={(event) => setDetails({ ...details, name: event.target.value })}
              placeholder={copy.namePlaceholder}
              autoComplete="name"
              className={FIELD}
            />
            <input
              name="email"
              type="email"
              value={details.email}
              onChange={(event) => setDetails({ ...details, email: event.target.value })}
              placeholder={copy.emailPlaceholder}
              autoComplete="email"
              className={FIELD}
            />
            <input
              name="phone"
              type="tel"
              value={details.phone}
              onChange={(event) => setDetails({ ...details, phone: event.target.value })}
              placeholder={copy.phonePlaceholder}
              autoComplete="tel"
              /* `tel`, not `number`: a leading zero and a '+' both matter, and a
                 spinner on a phone number is nonsense. */
              className={FIELD}
            />
          </div>
          <p className={`mt-1.5 text-xs ${detailsError ? 'text-red-600' : 'opacity-50'}`}>
            {detailsError ? copy.detailsMissing : copy.detailsHint}
          </p>

          {started ? (
            <button
              type="button"
              onClick={() => void saveDetails()}
              disabled={savingDetails}
              className="mt-2 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {copy.send}
            </button>
          ) : null}
        </div>
      ) : null}

      {!online && detailsSaved ? (
        <p className="shrink-0 border-t border-[var(--border)] px-4 py-2 text-xs opacity-70">
          {copy.detailsSaved}
        </p>
      ) : null}

      {visibleSuggestions.length > 0 ? (
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-2">
          <p className="mb-1 text-xs opacity-50">{copy.suggested}</p>
          <ul className="flex flex-col gap-1">
            {visibleSuggestions.map((article) => (
              <li key={article.slug}>
                <button
                  type="button"
                  onClick={() => onOpenArticle(article)}
                  className="text-start text-xs text-brand-600 underline underline-offset-2"
                >
                  {article.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form
        onSubmit={submit}
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
              void submit(event);
            }
          }}
          rows={2}
          maxLength={5000}
          placeholder={copy.placeholder}
          /*
            16px, not the 14px the rest of the widget reads at. Safari zooms
            the page in on any field smaller than that the moment it is
            focused, and a zoomed page is a scrolled page — which on iOS is
            what parts a caret from the field it belongs to. Sizing the field
            up is the fix that does not also disable pinch-zoom for the
            visitor.
          */
          className="min-w-0 flex-1 resize-none rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-base outline-none focus:border-brand-500"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {copy.send}
        </button>
      </form>
    </div>
  );
}

export type OfflineDetails = { name: string; email: string; phone: string };

/* Shared by the three fields; 16px for the same reason as the composer. */
const FIELD =
  'w-full min-w-0 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-base outline-none focus:border-brand-500';
