'use client';

import { useState } from 'react';
import { ThumbsDownIcon, ThumbsUpIcon } from '@/components/icons';
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
      <p className="text-center text-sm font-medium text-[var(--kb-muted)]" role="status">
        {t(locale, 'thanks')}
      </p>
    );
  }

  return (
    <section className="kb-noprint text-center">
      <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
        <p className="font-semibold text-[var(--kb-heading)]">{t(locale, 'wasHelpful')}</p>

        <div className="flex items-center gap-3">
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
          className="mx-auto mt-5 flex max-w-md flex-col items-center gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send(false, comment.trim() || undefined);
            setDone(true);
          }}
        >
          <label htmlFor="kb-feedback-comment" className="sr-only">
            {t(locale, 'feedbackPlaceholder')}
          </label>
          <textarea
            id="kb-feedback-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            maxLength={2000}
            autoFocus
            placeholder={t(locale, 'feedbackPlaceholder')}
            className="w-full rounded-lg border border-[var(--kb-border-strong)] bg-[var(--kb-surface)] px-3 py-2 text-base text-[var(--kb-heading)] outline-none focus:border-[var(--kb-band)] sm:text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-[var(--button-primary)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--button-primary-hover)]"
          >
            {t(locale, 'send')}
          </button>
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
      className={`inline-flex items-center gap-2 rounded-md border px-5 py-2 font-semibold transition-colors hover:bg-[var(--kb-surface-2)] ${
        pressed ? 'border-[var(--kb-border-strong)]' : 'border-[var(--kb-border)]'
      } ${tone === 'yes' ? 'text-[var(--kb-yes)]' : 'text-[var(--kb-no)]'}`}
    >
      {tone === 'yes' ? <ThumbsUpIcon size={18} /> : <ThumbsDownIcon size={18} />}
      {label}
    </button>
  );
}
