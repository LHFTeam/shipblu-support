'use client';

import { useState } from 'react';
import { Button, Textarea } from '@/components/ui';
import { t, type Locale, type StringKey } from '@/lib/kb/locale';

/**
 * Five worded ratings and an optional sentence.
 *
 * The rating posts on click rather than waiting for a submit button: most
 * people answer the number and leave, and making them press Send afterwards is
 * how a survey loses the responses it did get. The comment box appears after
 * the rating is in, and saves separately.
 */

/*
  Words, not faces. The faces were emoji, which the design system does not use
  as icons, and a face leaves the customer guessing which of two frowns is the
  worse one. The stored value is still the number, so the reports are unchanged.
*/
const RATINGS: { value: 1 | 2 | 3 | 4 | 5; label: StringKey }[] = [
  { value: 1, label: 'csatRating1' },
  { value: 2, label: 'csatRating2' },
  { value: 3, label: 'csatRating3' },
  { value: 4, label: 'csatRating4' },
  { value: 5, label: 'csatRating5' },
];

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
      <div className="kb-panel mx-auto max-w-[600px] p-7">
        <h1 className="text-2xl font-bold text-(--color-text-primary)">
          {t(locale, 'csatThanks')}
        </h1>
        <p className="mt-2 text-sm text-(--color-text-secondary)">{t(locale, 'csatRecorded')}</p>
      </div>
    );
  }

  return (
    <section className="kb-panel mx-auto max-w-[600px] p-7">
      <h1 className="text-2xl font-bold text-(--color-text-primary)">
        {t(locale, 'csatQuestion')}
      </h1>

      {/* Stacked on a phone, where five words side by side do not fit; one row
          from `sm`, worst first in reading order — so right to left in Arabic. */}
      <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-5">
        {RATINGS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={rating === value}
            onClick={() => {
              setRating(value);
              void send(value, null);
            }}
            className={`min-h-[42px] rounded-md border px-3 py-2.5 text-sm font-medium transition-colors ${
              rating === value
                ? 'border-(--color-action-primary-default) bg-(--color-background-selected) text-(--color-text-primary)'
                : 'border-(--color-border-default) bg-(--color-background-surface) text-(--color-text-primary) hover:bg-(--color-background-hover)'
            }`}
          >
            {t(locale, label)}
          </button>
        ))}
      </div>

      {rating !== null ? (
        <div className="mt-8 flex flex-col items-start gap-2">
          <label className="text-sm text-(--color-text-secondary)" htmlFor="csat-comment">
            {t(locale, 'csatCommentPrompt')}
          </label>
          <Textarea
            id="csat-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={4}
          />
          <Button
            className="mt-1"
            onClick={() => {
              void send(rating, comment.trim() || null);
              setSaved(true);
            }}
          >
            {t(locale, 'send')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
