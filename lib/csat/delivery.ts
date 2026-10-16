/**
 * How a survey went out and which door its answer came back through, in
 * words.
 *
 * Pure, for the reason `skip-reasons.ts` gives: the timeline's `describeEvent`,
 * the admin page's recent list and the ticket sidebar each print these, and
 * the first two must stay clear of anything that would pull a database client
 * into the browser bundle. The keys are the `csat_delivery` and
 * `csat_answer_source` enums.
 */
export const DELIVERIES = {
  email_link: 'by email',
  text_link: 'as a message',
  widget_card: 'as a card in the chat',
} as const;

export type SurveyDelivery = keyof typeof DELIVERIES;

export const ANSWER_SOURCES = {
  page: 'on the survey page',
  widget: 'in the chat widget',
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
