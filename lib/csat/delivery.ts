/**
 * How a survey went out and which door its answer came back through, in
 * words.
 *
 * Pure, for the reason `skip-reasons.ts` gives: the timeline's `describeEvent`
 * and the admin page's recent list print these, and both must stay clear of
 * anything that would pull a database client into the browser bundle. The
 * keys are the `csat_delivery` and `csat_answer_source` enums.
 */
export const DELIVERIES = {
  email_link: 'by email',
  text_link: 'as a message',
  widget_card: 'as a card in the chat',
  meta_template: 'as Messenger’s feedback card',
  meta_quick_reply: 'as rating buttons in the conversation',
} as const;

export type SurveyDelivery = keyof typeof DELIVERIES;

/**
 * Whether a delivery carries a link to the survey page. Meta's two do not:
 * Messenger's card and a tapped quick reply are answered where they were
 * asked, and come back on Meta's webhook with the survey's id in them.
 */
export function carriesLink(delivery: SurveyDelivery): boolean {
  return delivery !== 'meta_template' && delivery !== 'meta_quick_reply';
}

export const ANSWER_SOURCES = {
  page: 'on the survey page',
  widget: 'in the chat widget',
  meta_feedback: 'on Messenger’s feedback card',
  meta_quick_reply: 'with a rating button in the conversation',
} as const;

export type AnswerSource = keyof typeof ANSWER_SOURCES;

/** The phrase for a delivery read back from the database, which may predate this list. */
export function describeDelivery(delivery: unknown): string {
  return typeof delivery === 'string' && Object.hasOwn(DELIVERIES, delivery)
    ? DELIVERIES[delivery as SurveyDelivery]
    : 'as a message';
}

/** The phrase for an answer's source, or null for one recorded before the column existed. */
export function describeAnswerSource(source: unknown): string | null {
  return typeof source === 'string' && Object.hasOwn(ANSWER_SOURCES, source)
    ? ANSWER_SOURCES[source as AnswerSource]
    : null;
}
