/**
 * Messenger's customer feedback card: the satisfaction survey Meta draws itself.
 *
 * A pure module beside `send.ts`, for the reason that one gives and this one
 * gives again: **a wrong request shape is invisible in the response**. Graph
 * answers a template it cannot build with `(#100)` and a sentence that names
 * no field, so the shape is written down here from the reference (Messenger
 * Platform → Send Messages → Templates → Customer Feedback Template) and
 * asserted in a unit test — the only check available, since nothing local can
 * call Graph.
 *
 * What the reference fixes, and this keeps:
 *
 * - **One screen, one `csat` question on a five-point scale**, with an
 *   optional free-form follow-up. The survey is the same 1–5 on every channel
 *   (`plans/csat.md`), so the card asks nothing else.
 * - **Question ids are letters, digits and underscores.** A uuid's hyphens are
 *   refused, so the id is the survey's uuid without them behind a `csat_`
 *   prefix — which is also how the answer, arriving on the `messaging_feedback`
 *   webhook keyed by that id, finds its row (`surveyIdFromQuestionId`).
 * - **`business_privacy.url` is required.** The admin page holds it; with
 *   none, no card is sent — Facebook gets the rating buttons inside the 24
 *   hours, and past them is skipped as `no_privacy_url`.
 * - **`expires_in_days` is 1–7.**
 * - **Past the 24-hour window it sends with the `CUSTOMER_FEEDBACK` tag**, for
 *   up to seven days after the customer's last message, and that tag is valid
 *   on this card and nothing else (`feedbackTemplateTag`): "use in any other
 *   form is prohibited and will fail". The template page's example carries no
 *   `messaging_type` at all; the Page messages reference is what defines
 *   `MESSAGE_TAG` as how a tag travels and `RESPONSE` as a reply inside the
 *   window, and the second is what every in-window Messenger send here
 *   already carries (`send.ts`).
 * - **The follow-up answer is at most 400 characters**, inside the comment
 *   column's own limit.
 *
 * Messenger only: Instagram has no such card and no such webhook on either
 * connection, which is why its survey is quick replies
 * (`quick-reply-survey.ts`), and why those are also this card's fallback the
 * day Meta — which marks the card "in development" — stops accepting it.
 */

/**
 * `expires_in_days`, as the reference bounds it. The admin form and its
 * action read these (`lib/csat/limits.ts`), so what saves is what sends.
 */
export const MIN_EXPIRES_IN_DAYS = 1;
export const MAX_EXPIRES_IN_DAYS = 7;

/** The card's words and settings, as the survey job froze them on the message. */
export type FeedbackCard = {
  /** The card's title: the survey's first line. */
  title: string;
  subtitle: string;
  /** The button that opens the question. */
  button: string;
  /** The question, on the screen the button opens. */
  question: string;
  /** The follow-up box's placeholder. */
  placeholder: string;
  /** `business_privacy.url`. */
  privacyUrl: string;
  /** `expires_in_days`, clamped to Meta's 1–7 (`MIN_EXPIRES_IN_DAYS`…). */
  expiresInDays: number;
};

export type FeedbackTemplateRequest = {
  recipient: { id: string };
  messaging_type: 'RESPONSE' | 'MESSAGE_TAG';
  tag?: 'CUSTOMER_FEEDBACK';
  message: {
    attachment: {
      type: 'template';
      payload: {
        template_type: 'customer_feedback';
        title: string;
        subtitle: string;
        button_title: string;
        feedback_screens: {
          questions: {
            id: string;
            type: 'csat';
            title: string;
            score_label: 'neg_pos';
            score_option: 'five_stars';
            follow_up: { type: 'free_form'; placeholder: string };
          }[];
        }[];
        business_privacy: { url: string };
        expires_in_days: number;
      };
    };
  };
};

const QUESTION_ID = /^csat_([0-9a-f]{32})$/;

/** The card's question id for a survey: its uuid, hyphens dropped, behind `csat_`. */
export function feedbackQuestionId(surveyId: string): string {
  return `csat_${surveyId.replace(/-/g, '').toLowerCase()}`;
}

/** The survey a `messaging_feedback` question id names, or null for one that is not ours. */
export function surveyIdFromQuestionId(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const hex = QUESTION_ID.exec(id.toLowerCase())?.[1];
  if (!hex) return null;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function feedbackTemplateRequest(input: {
  recipientId: string;
  surveyId: string;
  card: FeedbackCard;
  /** `feedbackTemplateTag`'s answer: inside the window, or the seven days after it. */
  tag: 'RESPONSE' | 'CUSTOMER_FEEDBACK';
}): FeedbackTemplateRequest {
  const { card } = input;

  return {
    recipient: { id: input.recipientId },
    ...(input.tag === 'CUSTOMER_FEEDBACK'
      ? { messaging_type: 'MESSAGE_TAG' as const, tag: 'CUSTOMER_FEEDBACK' as const }
      : { messaging_type: 'RESPONSE' as const }),
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'customer_feedback',
          title: card.title,
          subtitle: card.subtitle,
          button_title: card.button,
          feedback_screens: [
            {
              questions: [
                {
                  id: feedbackQuestionId(input.surveyId),
                  type: 'csat',
                  title: card.question,
                  // Five stars, answered as `payload` "1"–"5" — the one scale
                  // the survey keeps on every channel. The value is the
                  // reference's own example and its stated default; the page
                  // spells the numeric alternative two ways (`one_to_five` in
                  // its score types, `1_to_5` in its properties table), and a
                  // value Graph does not know is a refused card.
                  score_label: 'neg_pos',
                  score_option: 'five_stars',
                  follow_up: { type: 'free_form', placeholder: card.placeholder },
                },
              ],
            },
          ],
          business_privacy: { url: card.privacyUrl },
          expires_in_days: Math.min(
            MAX_EXPIRES_IN_DAYS,
            Math.max(MIN_EXPIRES_IN_DAYS, Math.round(card.expiresInDays)),
          ),
        },
      },
    },
  };
}
