'use client';

import { useState } from 'react';
import { type Locale, t } from '@/lib/kb/locale';

/**
 * "Was this helpful?" — the one signal that tells the team which articles are
 * failing readers.
 *
 * The comment box only appears after "No". Asking everyone for prose collapses
 * the response rate; asking only the people who were not helped is where the
 * useful text comes from.
 */
export function ArticleFeedback({ articleId, locale }: { articleId: string; locale: Locale }) {
  const [answer, setAnswer] = useState<boolean | null>(null);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);

  async function send(wasHelpful: boolean, text?: string) {
    await fetch('/api/kb/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, wasHelpful, comment: text ?? null }),
    }).catch(() => {
      // Swallowed on purpose: a failed feedback post must not show a customer
      // an error on an article that answered their question.
    });
  }

  if (done) {
    return (
      <p className="mt-10 rounded-lg border border-[var(--border)] p-4 text-sm opacity-70">
        {t(locale, 'thanks')}
      </p>
    );
  }

  return (
    <section className="mt-10 rounded-lg border border-[var(--border)] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-medium">{t(locale, 'wasHelpful')}</p>

        <button
          type="button"
          onClick={() => {
            setAnswer(true);
            void send(true);
            setDone(true);
          }}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--muted)]"
        >
          {t(locale, 'yes')}
        </button>

        <button
          type="button"
          onClick={() => setAnswer(false)}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--muted)]"
        >
          {t(locale, 'no')}
        </button>
      </div>

      {answer === false ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(false, comment.trim() || undefined);
            setDone(true);
          }}
        >
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t(locale, 'feedbackPlaceholder')}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
          <button
            type="submit"
            className="self-start rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t(locale, 'send')}
          </button>
        </form>
      ) : null}
    </section>
  );
}
