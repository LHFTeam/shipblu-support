'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { CheckIcon } from '@/components/icons';
import { Button, ErrorText } from '@/components/ui';
import { MAX_COMMENT } from '@/lib/csat/limits';
import { direction } from '@/lib/kb/locale';
import type { WidgetSurvey } from '@/lib/widget/types';
import { copyFor } from './copy';
import { WIDGET_FIELD } from './field';

/**
 * What one answer came back as: the rating the survey holds afterwards, null
 * when there was nothing to answer — a survey a newer one closed — or false
 * when it did not go through.
 */
export type SurveyResult = number | null | false;

/**
 * The satisfaction survey, answered where the conversation happened.
 *
 * The message that carries it still holds the help-centre link, for the
 * console's timeline and for a widget loaded before this card existed; here
 * the visitor answers without leaving the chat. The flow is the survey page's:
 * a tap on a rating records it at once — most people answer the number and
 * leave — and the comment box opens after, saving separately.
 *
 * Unlike the page, a rating that went through cannot be changed by tapping
 * another: the first answer is the one kept (`recordAnswer`), so the card
 * shows the rating the server says it holds, and a scale still open after
 * that would be offering to change it. A rating that did not go through is
 * put back, with a sentence, so the visitor can tap again rather than believe
 * they answered.
 *
 * In the survey's own language and direction, which is the customer's and can
 * differ from the widget's: the message it stands in for was written in it.
 * Each worded line resolves its own direction as well, because a rule written
 * in one language falls back per field (`resolveWording`), and an English line
 * laid out right to left puts its full stop at the front.
 *
 * Its state lives here, keyed by the thread on the message: every push
 * replaces the whole transcript, and a card whose state lived above it would
 * lose a half-written comment to the next agent reply.
 */
export function SurveyCard({
  survey,
  onAnswer,
}: {
  survey: WidgetSurvey;
  onAnswer: (surveyId: string, rating: number, comment: string | null) => Promise<SurveyResult>;
}) {
  const copy = copyFor(survey.locale);
  const questionId = useId();
  const commentId = useId();

  /** The rating the server said it holds after this card's tap, as against the transcript's. */
  const [kept, setKept] = useState<number | null>(null);
  /** The rating tapped and on the wire, drawn chosen until the answer comes back. */
  const [pending, setPending] = useState<number | null>(null);
  const [step, setStep] = useState<'rate' | 'comment' | 'done'>('rate');
  /** The server found nothing to answer, though the transcript drew a scale. */
  const [shut, setShut] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /*
   * The next step brought into view as it opens. Below the scale it is
   * usually below the fold too — on a phone the out-of-hours form holds half
   * the screen — and a comment box nobody saw open is a thanks nobody reads.
   * Scrolled to, not focused: focus raises a phone's keyboard over a step
   * most people skip.
   */
  const next = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step !== 'rate') next.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [step]);

  const rating = pending ?? kept ?? survey.rating;
  // Answered on an earlier visit, or in another tab: the thanks and the
  // rating it was given, without a comment box this card never opened.
  const answeredElsewhere = kept === null && pending === null && survey.rating !== null;
  const closed = (survey.expired || shut) && rating === null;

  async function rate(value: number) {
    if (busy || rating !== null) return;
    setBusy(true);
    setFailed(false);
    setPending(value);

    const result = await onAnswer(survey.id, value, null);
    setPending(null);
    if (result === false) {
      setFailed(true);
    } else if (result === null) {
      setShut(true);
    } else {
      setKept(result);
      setStep('comment');
    }
    setBusy(false);
  }

  async function finish() {
    if (busy || rating === null) return;
    const text = comment.trim();
    // Nothing to add is an answer too, and the rating is already in.
    if (!text) {
      setFailed(false);
      setStep('done');
      return;
    }

    setBusy(true);
    setFailed(false);
    const result = await onAnswer(survey.id, rating, text);
    if (result === false) setFailed(true);
    else setStep('done');
    setBusy(false);
  }

  const done = step === 'done' || answeredElsewhere;

  return (
    <div
      dir={direction(survey.locale)}
      lang={survey.locale}
      className="flex w-72 max-w-full flex-col gap-3 rounded-bubble border border-(--color-border-subtle) bg-(--color-background-surface) px-(--bubble-pad-x) py-3 font-conversation text-sm text-(--color-text-primary)"
    >
      <div className="flex flex-col gap-0.5">
        {survey.intro ? (
          <p dir="auto" className="text-xs text-(--color-text-secondary)">
            {survey.intro}
          </p>
        ) : null}
        <p id={questionId} dir="auto" className="font-semibold">
          {survey.question}
        </p>
      </div>

      {closed ? (
        <p className="text-xs text-(--color-text-secondary)">{copy.surveyClosed}</p>
      ) : (
        /* Stacked, worst first in reading order: five words side by side do
           not fit a 380px panel, and a scale that wraps three and two reads as
           two questions. */
        <div role="group" aria-labelledby={questionId} className="flex flex-col gap-1.5">
          {survey.labels.map((label, index) => {
            const value = index + 1;
            const selected = rating === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                disabled={rating !== null || busy}
                onClick={() => void rate(value)}
                className={`flex min-h-(--tap-min) items-center justify-between gap-2 rounded-md border px-3 text-start transition-colors disabled:cursor-default ${
                  selected
                    ? 'border-(--color-action-primary-default) bg-(--color-background-selected) font-medium'
                    : 'border-(--color-border-default) bg-(--color-background-surface) enabled:hover:bg-(--color-background-hover) disabled:text-(--color-text-secondary)'
                }`}
              >
                <span>{label}</span>
                {/* The check says which, so the blue is not the only sign. */}
                {selected ? <CheckIcon size={16} className="shrink-0" /> : null}
              </button>
            );
          })}
        </div>
      )}

      {step === 'comment' ? (
        <div ref={next} className="flex flex-col gap-2">
          <label htmlFor={commentId} dir="auto" className="text-xs text-(--color-text-secondary)">
            {survey.commentPrompt}
          </label>
          <textarea
            id={commentId}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            maxLength={MAX_COMMENT}
            dir="auto"
            /* 16px, for the reason `field.ts` gives: Safari zooms on a smaller
               field the moment it takes focus. */
            className={`${WIDGET_FIELD} resize-none px-3 py-2`}
          />
          <Button
            onClick={() => void finish()}
            disabled={busy}
            loading={busy}
            dir="auto"
            className="self-start"
          >
            {survey.button}
          </Button>
        </div>
      ) : null}

      {done ? (
        <div ref={next}>
          <p role="status" className="flex items-start gap-1.5 text-(--color-feedback-success-fg)">
            <CheckIcon size={16} className="mt-0.5 shrink-0" />
            <span dir="auto">{survey.thanks}</span>
          </p>
        </div>
      ) : null}

      {/*
        Only while there is something to try again, and announced: a rating
        that did not go through leaves a screen reader's user on a button that
        went quiet, which sounds exactly like one that worked. Mounted with the
        sentence, so each failure is read out afresh.
      */}
      {failed && !done && !closed ? (
        <p role="alert">
          <ErrorText inline>{copy.surveyFailed}</ErrorText>
        </p>
      ) : null}
    </div>
  );
}
