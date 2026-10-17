'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { RelativeTime } from '@/components/relative-time';
import { DetailsSection } from '@/components/details-section';
import type { TicketSurveyState } from '@/lib/csat';
import { isClosedChat } from '@/lib/csat/decision';
import { describeSkip } from '@/lib/csat/skip-reasons';
import { ago } from '@/lib/format';
import { sendSurveyNow, setSurveySuppression } from '../../ticket-actions';
import { useFieldAction } from './use-field-action';

/**
 * What the satisfaction survey did on this ticket, and the two things an agent
 * can do about it: stop one going out, or send one now.
 *
 * The decision is shown whatever it was. A skipped survey used to leave
 * nothing on the ticket, so "why was this customer not asked?" was a worker
 * log search; the reason is the point of the block.
 *
 * "Send now" queues the job rather than sending: everything the scheduled
 * survey checks — reopened, suppressed, no address, the Meta window — is
 * checked there, so a manual send cannot bypass a rule the automatic one
 * obeys, and the ticket's timeline shows the outcome either way.
 */
export function SatisfactionField({
  conversationId,
  channel,
  statusCategory,
  suppressed,
  dropped,
  survey: state,
}: {
  conversationId: string;
  channel: string;
  statusCategory: string;
  suppressed: boolean;
  /** Spam or merged away: the job writes nothing, so "Send now" is not offered. */
  dropped: boolean;
  survey: TicketSurveyState;
}) {
  const { survey, newer, skip, latestId, availability } = state;
  const suppression = useFieldAction(setSurveySuppression);
  const send = useFieldAction(sendSurveyNow);
  // Queued is not sent: the job decides, and the timeline shows what it decided.
  // Remembered against the newest decision when the button was pressed, so it
  // clears itself the moment the job's lands — a survey or a skip, each a new
  // row — and the page re-renders with it; until then the button is gone, so
  // waiting cannot queue a second job. Derived rather than reset in an effect,
  // which would set state from a render.
  const [queuedOn, setQueuedOn] = useState<string | null>(null);
  const shown = latestId ?? 'none';
  const queued = queuedOn === shown;

  // A closed chat is a survey nobody could see, which the job refuses every
  // time; the button is not offered where its only answer is a refusal.
  const resolved =
    (statusCategory === 'resolved' || statusCategory === 'closed') &&
    !isClosedChat(channel, statusCategory);
  // A survey on its way or answered, with no later decision against another:
  // nothing to send now. After a later skip the button comes back, and the
  // job answers it on the ticket — "surveyed recently" included.
  const outstanding = skip === null && (survey?.status === 'sent' || survey?.status === 'answered');
  // Offered only where it could queue something: a button that answers
  // "surveys are switched off" every time is worse than none. The switch
  // itself stays on a channel that has one, because the flag outlives the
  // switch — an agent can keep a ticket out of a survey before an admin turns
  // surveys on.
  const surveyable = availability !== 'unsupported';

  return (
    <DetailsSection collapsible={false} title="Satisfaction">
      <div className="flex flex-col gap-2 text-xs text-(--color-text-secondary)">
        {survey === null ? (
          // Where no survey can go out, the line below says why instead.
          availability === 'on' || availability === 'unknown' ? (
            <p>No survey yet.</p>
          ) : null
        ) : survey.status === 'answered' ? (
          <>
            <p className="text-sm font-semibold text-(--color-text-primary)">
              Rated {survey.rating} / 5
              {survey.respondedAt ? (
                <RelativeTime at={survey.respondedAt}>
                  {(relative) => (
                    <span className="ms-1 text-xs font-normal text-(--color-text-tertiary)">
                      {ago(relative)}
                    </span>
                  )}
                </RelativeTime>
              ) : null}
            </p>
            {survey.comment ? (
              <blockquote
                dir="auto"
                className="font-conversation border-s-2 border-(--color-border-default) ps-2 text-(--color-text-primary)"
              >
                {survey.comment}
              </blockquote>
            ) : null}
            {newer ? (
              <p>
                A newer survey went out{' '}
                {newer.sentAt ? (
                  <RelativeTime at={newer.sentAt}>{(relative) => ago(relative)}</RelativeTime>
                ) : null}
                , no answer yet.
              </p>
            ) : null}
          </>
        ) : (
          <p>
            Survey sent{' '}
            {survey.sentAt ? (
              <RelativeTime at={survey.sentAt}>{(relative) => ago(relative)}</RelativeTime>
            ) : null}
            , no answer yet.
          </p>
        )}

        {skip ? (
          <p>
            {survey ? 'Not surveyed again' : 'Not surveyed'}
            <RelativeTime at={skip.createdAt}>
              {(relative) => ` ${ago(relative)}`}
            </RelativeTime>: {describeSkip(skip.reason)}.
          </p>
        ) : null}

        {suppressed ? (
          <p className="text-(--color-text-primary)">This ticket will not be surveyed.</p>
        ) : null}

        {availability === 'unsupported' ? (
          <p>Surveys are not sent on this channel.</p>
        ) : availability === 'unknown' ? (
          // Not "off": nobody switched anything, and the next render reads again.
          <p>Survey settings could not be read just now.</p>
        ) : availability !== 'on' ? (
          <p>
            Surveys are switched off
            {availability === 'channel_off' ? ' for this channel' : ''}.
          </p>
        ) : null}

        {surveyable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={suppression.pending}
              onClick={() =>
                void suppression.run({ conversationId, suppressed: suppressed ? 'off' : 'on' })
              }
            >
              {suppressed ? 'Allow a survey' : 'Don’t survey this ticket'}
            </Button>

            {availability === 'on' &&
            resolved &&
            !dropped &&
            !suppressed &&
            !outstanding &&
            !queued ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={send.pending}
                onClick={() =>
                  void send.run({ conversationId }).then((result) => {
                    if (!result.error) setQueuedOn(shown);
                  })
                }
              >
                Send survey now
              </Button>
            ) : null}
          </div>
        ) : null}

        {suppression.error ? (
          <p className="text-(--color-feedback-danger-fg)">{suppression.error}</p>
        ) : null}
        {send.error ? <p className="text-(--color-feedback-danger-fg)">{send.error}</p> : null}
        {queued ? <p>Survey queued; the outcome will show here in a minute.</p> : null}
      </div>
    </DetailsSection>
  );
}
