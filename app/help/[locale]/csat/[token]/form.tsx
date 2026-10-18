'use client';

import { useRef, useState } from 'react';
import { Button, ErrorText, Textarea } from '@/components/ui';
import { ratingLabels, type Wording } from '@/lib/csat/wording';
import { t, type Locale } from '@/lib/kb/locale';

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
 *
 * The first tap shuts the scale, whatever comes back. The first answer is the
 * one kept (`recordAnswer`), so a scale still open after it offered to change
 * a rating the server would not change: a customer who tapped 1 by mistake and
 * then 4 saw 4 chosen while a supervisor was emailed about the 1. Shut on the
 * tap rather than on the reply, because the page cannot tell a request that
 * never arrived from a reply that was lost after the rating was kept, and a
 * scale reopened after the second would take a 4 the route ignores. A tap the
 * route did not confirm says so, and the button below posts the same rating
 * again — recorded if the first never arrived, ignored if it did — and thanks
 * the customer only once the route has taken it, so a second failure leaves
 * the line up rather than a thanks for nothing.
 *
 * Shut, not disabled: `aria-disabled` and the guard in `rate`, because a
 * disabled button drops the focus it holds, and a keyboard or screen-reader
 * user who pressed a rating would be put back at the top of the page.
 *
 * The chat card differs in two ways, both because its route answers with the
 * rating it kept: the card draws that rating rather than the tap, and it can
 * reopen its scale after a failure, since a second tap there is answered with
 * the first rating if one was kept. This route answers 204 whatever happened,
 * so as not to tell a stranger which tokens exist.
 */

/**
 * How long a post may stay on the wire before the page stops waiting for it.
 * Long enough for a slow mobile connection; short enough that a dropped one
 * gives the customer the button back while they are still on the page.
 */
const SEND_DEADLINE_MS = 15_000;

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
  /** A rating was tapped: the scale is shut on it. */
  const [locked, setLocked] = useState(false);
  /**
   * The route took a post of the rating: only then may a comment go without
   * waiting. A ref, because the tap's post and the button's can both be out
   * at once, and whichever settles last has to see the other's answer.
   */
  const confirmed = useRef(false);
  /** The route did not confirm the rating's post, so the button below sends it again. */
  const [unconfirmed, setUnconfirmed] = useState(false);
  /** The button's post of the rating is on the wire. */
  const [finishing, setFinishing] = useState(false);
  const [comment, setComment] = useState('');
  const [saved, setSaved] = useState(false);
  const labels = ratingLabels(locale);

  function confirm() {
    confirmed.current = true;
    setUnconfirmed(false);
  }

  /**
   * Whether the route took it — not what it did with it, which it does not
   * say. Given up after `SEND_DEADLINE_MS`, so a request lost to a dropped
   * connection ends in the not-confirmed line and a button that works again,
   * rather than a "Sending…" nothing ends: posting the same rating twice is
   * harmless, since the route keeps the first answer and one comment.
   */
  async function send(value: number, text: string | null): Promise<boolean> {
    if (preview) return true;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), SEND_DEADLINE_MS);
    try {
      const response = await fetch('/api/kb/csat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, rating: value, comment: text }),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      // Caught: a customer who has already told us their score should not be
      // shown an error page about our own network. The line below the scale
      // says it was not confirmed instead.
      return false;
    } finally {
      clearTimeout(deadline);
    }
  }

  async function rate(value: number) {
    if (locked) return;
    setRating(value);
    setLocked(true);
    if (await send(value, null)) confirm();
    else if (!confirmed.current) setUnconfirmed(true);
  }

  async function finish(value: number) {
    // A press while the button's own post is on the wire starts no second
    // post; the first one's answer decides.
    if (finishing) return;
    const text = comment.trim() || null;
    // A comment after a rating the route took goes out without waiting: the
    // score is in, and a lost sentence is not worth a refusal on screen.
    if (confirmed.current) {
      void send(value, text);
      setSaved(true);
      return;
    }
    // Otherwise this is the rating's own post — a preselected rating never
    // tapped, a tap the route did not confirm or one still on the wire — and
    // the thanks waits for the route: the route records a rating it has not
    // seen and attaches a comment to one it has, so this one post is the
    // whole answer either way.
    setFinishing(true);
    setLocked(true);
    const took = await send(value, text);
    setFinishing(false);
    // The tap's own post may have been taken while this one was out: the
    // score is in either way, and only the sentence was lost.
    if (took || confirmed.current) {
      confirm();
      setSaved(true);
    } else {
      setUnconfirmed(true);
    }
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
              aria-disabled={locked}
              onClick={() => void rate(value)}
              className={`min-h-[42px] rounded-md border px-3 py-2.5 text-sm font-medium transition-colors aria-disabled:cursor-default ${
                rating === value
                  ? 'border-(--color-action-primary-default) bg-(--color-background-selected) text-(--color-text-primary)'
                  : locked
                    ? 'border-(--color-border-default) bg-(--color-background-surface) text-(--color-text-secondary)'
                    : 'border-(--color-border-default) bg-(--color-background-surface) text-(--color-text-primary) hover:bg-(--color-background-hover)'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {unconfirmed ? (
        <div className="mt-3">
          <ErrorText>{t(locale, 'csatNotConfirmed')}</ErrorText>
        </div>
      ) : null}

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
          {/* Busy, not disabled, for the scale's reason: a disabled button
              drops the focus it holds. The guard in `finish` takes no second
              press while the first is on the wire. */}
          <Button className="mt-1" loading={finishing} onClick={() => void finish(rating)}>
            {finishing ? t(locale, 'csatSending') : wording.button}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
