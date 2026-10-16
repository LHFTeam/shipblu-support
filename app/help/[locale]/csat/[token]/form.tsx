'use client';

import { useState } from 'react';
import { Button, Textarea } from '@/components/ui';
import { ratingLabels, type Wording } from '@/lib/csat/wording';
import type { Locale } from '@/lib/kb/locale';

/**
 * Five worded ratings and an optional sentence.
 *
 * A tap on a rating posts it at once rather than waiting for a button: most
 * people answer the number and leave, and making them press Send afterwards
 * is how a survey loses the responses it did get. The comment box appears
 * after the rating is in, and saves separately.
 *
 * A rating the link named (`preselected`) is shown chosen with the comment box
 * already open, and is posted on the first tap — the rating again, or the
 * button — never on arrival, for the reason the page gives. In preview mode
 * nothing is posted at all: it is the admin's "send a test" looking at the
 * page the customer would see.
 */

/*
  Words, not faces. The faces were emoji, which the design system does not use
  as icons, and a face leaves the customer guessing which of two frowns is the
  worse one. The stored value is still the number, so the reports are unchanged.
*/
export function SurveyForm({
  token,
  locale,
  wording,
  preselected = null,
  preview = false,
}: {
  token: string;
  locale: Locale;
  wording: Wording;
  preselected?: number | null;
  preview?: boolean;
}) {
  const [rating, setRating] = useState<number | null>(preselected);
  // Whether the rating on screen has reached the server: false for a
  // preselected one until the customer taps.
  const [posted, setPosted] = useState(false);
  const [comment, setComment] = useState('');
  const [saved, setSaved] = useState(false);
  const labels = ratingLabels(locale);

  async function send(value: number, text: string | null) {
    if (preview) return;
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
        <h1 className="text-2xl font-bold text-(--color-text-primary)">{wording.thanks}</h1>
      </div>
    );
  }

  return (
    <section className="kb-panel mx-auto max-w-[600px] p-7">
      {wording.intro ? (
        <p className="text-sm text-(--color-text-secondary)">{wording.intro}</p>
      ) : null}
      <h1 className="mt-1 text-2xl font-bold text-(--color-text-primary)">{wording.question}</h1>

      {/* Stacked on a phone, where five words side by side do not fit; one row
          from `sm`, worst first in reading order — so right to left in Arabic. */}
      <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-5">
        {labels.map((label, index) => {
          const value = index + 1;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={rating === value}
              onClick={() => {
                setRating(value);
                setPosted(true);
                void send(value, null);
              }}
              className={`min-h-[42px] rounded-md border px-3 py-2.5 text-sm font-medium transition-colors ${
                rating === value
                  ? 'border-(--color-action-primary-default) bg-(--color-background-selected) text-(--color-text-primary)'
                  : 'border-(--color-border-default) bg-(--color-background-surface) text-(--color-text-primary) hover:bg-(--color-background-hover)'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {rating !== null ? (
        <div className="mt-8 flex flex-col items-start gap-2">
          <label className="text-sm text-(--color-text-secondary)" htmlFor="csat-comment">
            {wording.commentPrompt}
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
              // A preselected rating that was never tapped goes with the
              // comment, so the one tap on this button is the whole answer.
              void send(rating, comment.trim() || (posted ? null : ''));
              setSaved(true);
            }}
          >
            {wording.button}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
