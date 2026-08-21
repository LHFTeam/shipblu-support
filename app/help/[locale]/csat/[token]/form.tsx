'use client';

import { useState } from 'react';
import { t, type Locale } from '@/lib/kb/locale';

/**
 * Five faces and an optional sentence.
 *
 * The rating posts on click rather than waiting for a submit button: most
 * people answer the number and leave, and making them press Send afterwards is
 * how a survey loses the responses it did get. The comment box appears after
 * the rating is in, and saves separately.
 */

const RATINGS = [1, 2, 3, 4, 5] as const;

const FACES: Record<number, string> = {
  1: '😠',
  2: '🙁',
  3: '😐',
  4: '🙂',
  5: '😀',
};

export function SurveyForm({ token, locale }: { token: string; locale: Locale }) {
  const [rating, setRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [saved, setSaved] = useState(false);

  async function send(value: number, text: string | null) {
    await fetch('/api/kb/csat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, rating: value, comment: text }),
    }).catch(() => {
      // Swallowed: a customer who has already told us their score should not be
      // shown an error page about our own network.
    });
  }

  if (saved) {
    return (
      <div className="kb-panel mx-auto max-w-lg p-8 text-center">
        <h1 className="text-xl font-semibold text-[var(--kb-heading)]">
          {t(locale, 'csatThanks')}
        </h1>
        <p className="mt-2 text-sm text-[var(--kb-muted)]">{t(locale, 'csatRecorded')}</p>
      </div>
    );
  }

  return (
    <section className="kb-panel mx-auto max-w-lg p-8 text-center">
      <h1 className="text-xl font-semibold text-[var(--kb-heading)]">
        {t(locale, 'csatQuestion')}
      </h1>

      <div className="mt-6 flex justify-center gap-2">
        {RATINGS.map((value) => (
          <button
            key={value}
            type="button"
            aria-label={`${value}`}
            aria-pressed={rating === value}
            onClick={() => {
              setRating(value);
              void send(value, null);
            }}
            className={`rounded-lg border px-4 py-3 text-2xl transition-colors hover:bg-[var(--kb-surface-2)] ${
              rating === value
                ? 'border-[var(--kb-band)] bg-[var(--kb-band-soft)]'
                : 'border-[var(--kb-border)]'
            }`}
          >
            {FACES[value]}
          </button>
        ))}
      </div>

      {rating !== null ? (
        <div className="mt-8 text-start">
          <label className="text-sm text-[var(--kb-muted)]" htmlFor="csat-comment">
            {t(locale, 'csatCommentPrompt')}
          </label>
          <textarea
            id="csat-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={4}
            className="mt-2 w-full rounded-lg border border-[var(--kb-border-strong)] bg-[var(--kb-surface)] p-3 text-base text-[var(--kb-heading)] outline-none focus:border-[var(--kb-band)] sm:text-sm"
          />
          <button
            type="button"
            onClick={() => {
              void send(rating, comment.trim() || null);
              setSaved(true);
            }}
            className="mt-3 rounded-md bg-[var(--button-primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--button-primary-hover)]"
          >
            {t(locale, 'send')}
          </button>
        </div>
      ) : null}
    </section>
  );
}
