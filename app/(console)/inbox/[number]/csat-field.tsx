'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { RelativeTime } from '@/components/relative-time';
import { DetailsSection } from '@/components/details-section';
import type { SurveySummary } from '@/lib/csat';
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
  statusCategory,
  suppressed,
  survey,
}: {
  conversationId: string;
  statusCategory: string;
  suppressed: boolean;
  survey: SurveySummary | null;
}) {
  const suppression = useFieldAction(setSurveySuppression);
  const send = useFieldAction(sendSurveyNow);
  // Queued is not sent: the job decides, and the timeline shows what it decided.
  const [queued, setQueued] = useState(false);

  const resolved = statusCategory === 'resolved' || statusCategory === 'closed';
  const outstanding = survey?.status === 'sent' || survey?.status === 'answered';

  return (
    <DetailsSection collapsible={false} title="Satisfaction">
      <div className="flex flex-col gap-2 text-xs text-(--color-text-secondary)">
        {survey === null ? (
          <p>No survey yet.</p>
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
          </>
        ) : survey.status === 'sent' || survey.status === 'expired' ? (
          <p>
            Survey sent{' '}
            {survey.sentAt ? (
              <RelativeTime at={survey.sentAt}>{(relative) => ago(relative)}</RelativeTime>
            ) : null}
            , no answer yet.
          </p>
        ) : (
          <p>Not surveyed: {describeSkip(survey.skipReason)}.</p>
        )}

        {suppressed ? (
          <p className="text-(--color-text-primary)">This ticket will not be surveyed.</p>
        ) : null}

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

          {resolved && !suppressed && !outstanding ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={send.pending}
              onClick={() =>
                void send.run({ conversationId }).then((result) => {
                  if (!result.error) setQueued(true);
                })
              }
            >
              Send survey now
            </Button>
          ) : null}
        </div>

        {suppression.error ? (
          <p className="text-(--color-feedback-danger-fg)">{suppression.error}</p>
        ) : null}
        {send.error ? <p className="text-(--color-feedback-danger-fg)">{send.error}</p> : null}
        {queued ? <p>Survey queued; the outcome will show here in a minute.</p> : null}
      </div>
    </DetailsSection>
  );
}
