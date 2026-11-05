'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CheckIcon } from '@/components/icons';
import { Button, buttonClass, Textarea } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';

/**
 * "Did this article answer your question?" — the one signal that tells the team
 * which articles are failing readers.
 *
 * The comment box only appears after "No". Asking everyone for prose collapses
 * the response rate; asking only the people who were not helped is where the
 * useful text comes from. That is also why "No" posts nothing until the box is
 * sent: the design answers "No" straight away with a Contact support button,
 * and a reader handed the way out at once never writes the sentence that says
 * what the article was missing. The button comes after the sentence instead.
 *
 * The two answers are secondary buttons, as the design draws them, where they
 * used to be green and red. The colours ranked the answers — a red "No" reads as
 * the wrong one to give, and it is the one the team most needs to hear — and the
 * reason they were there, that two identical grey buttons read as a form rather
 * than a question, is answered by the card and by labels that are answers in
 * words: "Yes, it did", "No, I still need help". "No", once pressed, keeps a
 * pressed look as well as `aria-pressed`, and the box opening under it is what
 * says it was heard.
 *
 * When the question gives way to the thanks, focus follows it. The button that
 * had focus is gone, and without the move a keyboard reader's next Tab starts
 * again from the top of the page.
 */
export function ArticleFeedback({ articleId, locale }: { articleId: string; locale: Locale }) {
  const [answer, setAnswer] = useState<boolean | null>(null);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);
  const thanks = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (done) thanks.current?.focus();
  }, [done]);

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

  // A bordered box rather than `.kb-panel`: the design draws it flat, like the
  // two links under it, and a shadow on the one card among them would rank the
  // question above the way on.
  return (
    <section className="kb-noprint rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) px-5 py-4 text-start">
      {done && answer ? (
        <p
          ref={thanks}
          tabIndex={-1}
          className="flex items-center gap-2 text-sm text-(--color-text-secondary) outline-none"
        >
          {/* The design's circle-check, drawn as a ring round the plain tick. */}
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-current text-(--color-feedback-success-fg)">
            <CheckIcon size={10} strokeWidth={2.75} />
          </span>
          {t(locale, 'feedbackThanksYes')}
        </p>
      ) : done ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <p
            ref={thanks}
            tabIndex={-1}
            className="min-w-0 flex-[1_1_15rem] text-sm text-(--color-text-secondary) outline-none"
          >
            {t(locale, 'feedbackThanksNo')}
          </p>
          {/* Straight to the forms, as the help band below does: somebody who
              has just said the article did not help has already chosen to ask. */}
          <Link href={`/${locale}/forms`} className={buttonClass()}>
            {t(locale, 'contactAction')}
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <p className="min-w-0 flex-[1_1_12.5rem] text-sm font-bold text-(--color-text-primary)">
              {t(locale, 'feedbackQuestion')}
            </p>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                aria-pressed={false}
                onClick={() => {
                  setAnswer(true);
                  void send(true);
                  setDone(true);
                }}
              >
                {t(locale, 'feedbackYes')}
              </Button>
              {/* `!` because a class on a primitive does not reliably beat its
                  own variant's colours (§6.93). */}
              <Button
                variant="secondary"
                aria-pressed={answer === false}
                className="aria-pressed:border-(--color-action-primary-default)! aria-pressed:bg-(--color-background-selected)! aria-pressed:text-(--color-text-brand)!"
                onClick={() => setAnswer(false)}
              >
                {t(locale, 'feedbackNo')}
              </Button>
            </div>
          </div>

          {answer === false ? (
            <form
              className="mt-4 flex flex-col items-start gap-2"
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
        </>
      )}
    </section>
  );
}
