/**
 * Why a resolved ticket got no satisfaction survey.
 *
 * Pure: the keys are what `send_csat` writes into `csat_surveys.skip_reason`,
 * the sentences are what the ticket's timeline, the sidebar and the admin
 * page's recent list print for them. One module so the three cannot word the
 * same reason three ways, and so the timeline's `describeEvent` — which keeps
 * clear of anything that would pull a database client into the browser bundle
 * — can still name the reason.
 *
 * "Surveyed recently" is deliberately not one: a ticket that already carries
 * its survey needs no second row saying so, and the row it would sit on top
 * of is the answer (`sendSurvey` in `lib/csat`).
 */
export const SKIP_REASONS = {
  csat_off: 'surveys are switched off',
  channel_off: 'surveys are off for this channel',
  reopened: 'the ticket was reopened before the survey went out',
  read_only_channel: 'the conversation belongs to another service',
  no_customer_message: 'the customer never wrote on this ticket',
  agent_suppressed: 'an agent asked that this ticket not be surveyed',
  rule_resolved: 'a rule resolved it, and rule-resolved tickets are not surveyed',
  no_address: 'there is no email address to send it to',
  comment_thread: 'the conversation is a public comment thread, where a survey would be public too',
  window_closed: 'the messaging window had closed',
} as const;

export type SkipReason = keyof typeof SKIP_REASONS;

/** The sentence for a reason read back from the database, which may predate this list. */
export function describeSkip(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(SKIP_REASONS, reason)
    ? SKIP_REASONS[reason as SkipReason]
    : 'for a reason this version does not know';
}
