'use client';

import { useState } from 'react';
import { ThumbsDownIcon, ThumbsUpIcon } from '@/components/icons';
import { Button, Textarea } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';

/**
 * "Was this article helpful?" — the one signal that tells the team which
 * articles are failing readers.
 *
 * The comment box only appears after "No". Asking everyone for prose collapses
 * the response rate; asking only the people who were not helped is where the
 * useful text comes from.
 *
 * The two buttons carry green and red, which is the live portal's treatment and
 * the right one: this is the last thing on a long page and a pair of identical
 * grey buttons reads as a form to fill in rather than a question to answer.
 * "No", once pressed, takes its colour into the border too, so the box that
 * opened under it is visibly the answer to that button.
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
      <p className="text-start text-sm text-(--color-text-secondary)" role="status">
        {t(locale, 'thanks')}
      </p>
    );
  }

  return (
    <section className="kb-noprint text-start">
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="me-1 text-base font-bold text-(--color-text-primary)">
          {t(locale, 'wasHelpful')}
        </p>

        <div className="flex items-center gap-2.5">
          <FeedbackButton
            tone="yes"
            label={t(locale, 'yes')}
            onClick={() => {
              setAnswer(true);
              void send(true);
              setDone(true);
            }}
          />
          <FeedbackButton
            tone="no"
            label={t(locale, 'no')}
            pressed={answer === false}
            onClick={() => setAnswer(false)}
          />
        </div>
      </div>

      {answer === false ? (
        <form
          className="mt-4 flex max-w-[520px] flex-col items-start gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(false, comment.trim() || undefined);
            setDone(true);
          }}
        >
          <label htmlFor="kb-feedback-comment" className="sr-only">
            {t(locale, 'feedbackPlaceholder')}
          </label>
          <Textarea
            id="kb-feedback-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            maxLength={2000}
            autoFocus
            placeholder={t(locale, 'feedbackPlaceholder')}
          />
          <Button type="submit">{t(locale, 'send')}</Button>
        </form>
      ) : null}
    </section>
  );
}

function FeedbackButton({
  tone,
  label,
  pressed = false,
  onClick,
}: {
  tone: 'yes' | 'no';
  label: string;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      className={`inline-flex min-h-[42px] items-center gap-2 rounded-md border bg-(--color-background-surface) px-3 py-1.5 text-sm font-medium transition-colors hover:bg-(--color-background-hover) sm:min-h-[34px] ${
        tone === 'yes'
          ? 'text-(--color-feedback-success-fg)'
          : pressed
            ? 'border-(--color-feedback-danger-fg) text-(--color-feedback-danger-fg)'
            : 'text-(--color-feedback-danger-fg)'
      } ${pressed ? '' : 'border-(--color-border-default)'}`}
    >
      {tone === 'yes' ? <ThumbsUpIcon size={18} /> : <ThumbsDownIcon size={18} />}
      {label}
    </button>
  );
}
