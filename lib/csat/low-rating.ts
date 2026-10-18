import { can, type AgentRole } from '@/lib/auth/permissions';
import { emailButton, emailShell, escapeHtml, type EmailBody } from '@/lib/email/html';

/**
 * Who hears about a 1 or a 2, and what they are told.
 *
 * Pure, so the rules are tests rather than a reading of the handler
 * (`worker/handlers/notify-low-rating.ts`, which decides when and records
 * who).
 *
 * **Who.** Everybody active who can see the satisfaction report and every
 * ticket — `report.view` and `ticket.view.all` together, never one of them.
 * `report.view` alone is somebody who reads the numbers but may be unable to
 * open the ticket the email points at; `ticket.view.all` alone is an agent
 * who sees the whole queue but was not given the ratings, which `listInbox`'s
 * "Rated 1–2" view and the report's comments both withhold from them. Both is
 * somebody whose job includes following a bad answer up, which is what the
 * email asks of them. An agent who never set a password is left out: they
 * cannot sign in to open it.
 *
 * **What.** The ticket's number, the score, the group the survey snapshotted
 * and a link — and its agent only to a recipient holding `report.agents`, as
 * `/reports/csat` names an agent beside a score only to them: an email per bad
 * answer naming the colleague would otherwise be the per-agent list of low
 * scores the report withholds, kept in a mailbox. Never
 * the customer's words, and never the ticket's subject, which for a chat is
 * its opening message: an email is copied to phones, lock screens and mail
 * archives this system cannot reach back into, and the comment is a click
 * away on the ticket for whoever is signed in. English only, as the agent
 * invitation is, because the console has no Arabic.
 */

export type AlertCandidate = {
  id: string;
  email: string;
  role: AgentRole;
  permissions: Record<string, boolean>;
  isActive: boolean;
  /** Whether the agent has set a password, so can sign in to open the link. */
  activated: boolean;
};

export function lowRatingRecipients<T extends AlertCandidate>(candidates: T[]): T[] {
  return candidates.filter(
    (agent) =>
      agent.isActive &&
      agent.activated &&
      can(agent, 'report.view') &&
      can(agent, 'ticket.view.all'),
  );
}

/** Whether this recipient's email names the agent: the report's `report.agents` rule. */
export function namesAgentTo(recipient: Pick<AlertCandidate, 'role' | 'permissions'>): boolean {
  return can(recipient, 'report.agents');
}

export type LowRatingAlert = {
  number: number;
  rating: number;
  /**
   * The survey's snapshot, null when nobody was assigned or the agent was
   * since removed — which the email cannot tell apart, so it says neither.
   */
  agentName: string | null;
  groupName: string | null;
  /** The console's ticket page, absolute. */
  url: string;
  /** `namesAgentTo` for the recipient this copy is for. */
  namesAgent: boolean;
};

export function lowRatingEmail(alert: LowRatingAlert): EmailBody {
  const headline = `Ticket #${alert.number} was rated ${alert.rating} / 5 by the customer.`;
  const facts = [
    ...(alert.namesAgent ? [`Agent: ${alert.agentName ?? 'none on record'}`] : []),
    `Group: ${alert.groupName ?? 'none'}`,
  ];
  const ask =
    'Open the ticket to read the conversation, and anything the customer added to the rating:';
  const why =
    'You get this because you can see the satisfaction report and every ticket. An admin can turn these emails off under Admin → Satisfaction surveys.';
  // A reply goes to the support mailbox (`sendTransactionalEmail`'s Reply-To),
  // where it is a new ticket from a colleague rather than an answer to anybody.
  const noReply = 'Don’t reply to this email — open the ticket instead.';

  return {
    subject: `Ticket #${alert.number} was rated ${alert.rating} / 5`,
    textBody: [
      headline,
      '',
      ...facts,
      '',
      ask,
      alert.url,
      '',
      why,
      noReply,
      '',
      'ShipBlu Support',
    ].join('\n'),
    htmlBody: emailShell([
      `<p>${escapeHtml(headline)}</p>`,
      `<p>${facts.map(escapeHtml).join('<br />')}</p>`,
      `<p>${escapeHtml(ask)}</p>`,
      ...emailButton(alert.url, `Open ticket #${alert.number}`),
      `<p style="color:#666;font-size:13px">${escapeHtml(why)} ${escapeHtml(noReply)}</p>`,
      '<p>ShipBlu Support</p>',
    ]),
  };
}
