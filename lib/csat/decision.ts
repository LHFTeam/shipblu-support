import type { CsatSettings } from './settings';
import type { SkipReason } from './skip-reasons';

/**
 * Whether a resolved ticket is surveyed, and how, decided in one place.
 *
 * Pure, and tested as a table: every input is a fact the job has already read,
 * so the order the checks run in — which is the order the reasons are reported
 * in — is here and nowhere else. The job (`worker/handlers/send-csat.ts`) reads
 * the rows, this decides, the job writes what was decided.
 *
 * The checks are ordered from the cheapest explanation to the most specific:
 * an admin who switched surveys off should read "switched off" on every
 * ticket, not a different reason on each depending on which other check
 * happened to fire first.
 */

/** Who asked for the survey: an agent resolving, a rule resolving, or the sidebar's "Send now". */
export type SurveyTrigger = 'agent' | 'rule' | 'manual';

export type DecisionInput = {
  channel: string;
  statusCategory: string;
  deletedAt: Date | null;
  isSpam: boolean;
  mergedIntoId: string | null;
  /** Whether any inbound reply on the ticket carries words the customer wrote. */
  hasCustomerWords: boolean;
  suppressed: boolean;
  trigger: SurveyTrigger;
  recentlySurveyed: boolean;
  contactEmail: string | null;
  /**
   * On Facebook and Instagram, whether an automated message can send right
   * now (`automatedReplyBlocked` answered null). Ignored elsewhere.
   */
  metaWindowOpen: boolean;
  /** Whether the channel is one nobody on the team writes to (`isReadOnlyChannel`). */
  readOnly: boolean;
  /** Whether a message on this channel is written as an email (`sendsByEmail`). */
  byEmail: boolean;
};

export type Decision =
  | { kind: 'send'; delivery: 'email_link' | 'text_link' }
  | { kind: 'skip'; reason: SkipReason }
  /** The ticket is gone — deleted, spam, merged away — and nothing is written. */
  | { kind: 'drop' };

/**
 * Whether the admin has surveys on for this channel. `portal` rides email's
 * switch because it rides email's carrier; WhatsApp and the bot have no
 * switch, for the reason `plans/csat.md` gives.
 */
export function channelSurveyed(settings: CsatSettings, channel: string): boolean {
  switch (channel) {
    case 'email':
    case 'portal':
      return settings.channels.email;
    case 'webchat':
      return settings.channels.webchat;
    case 'facebook':
      return settings.channels.facebook;
    case 'instagram':
      return settings.channels.instagram;
    case 'api':
      return settings.channels.api;
    default:
      return false;
  }
}

export function decideSurvey(input: DecisionInput, settings: CsatSettings): Decision {
  if (input.deletedAt || input.isSpam || input.mergedIntoId) return { kind: 'drop' };

  if (!settings.enabled) return { kind: 'skip', reason: 'csat_off' };
  if (!channelSurveyed(settings, input.channel)) return { kind: 'skip', reason: 'channel_off' };

  // The customer came back in the grace period: they want an answer, not a
  // survey. The next resolution schedules a new one.
  if (input.statusCategory !== 'resolved' && input.statusCategory !== 'closed') {
    return { kind: 'skip', reason: 'reopened' };
  }

  // Asking the customer to rate our support on the strength of a conversation
  // the team never had would be asking about someone else's work.
  if (input.readOnly) return { kind: 'skip', reason: 'read_only_channel' };

  // An agent-opened ticket the customer never answered has nothing to rate.
  if (!input.hasCustomerWords) return { kind: 'skip', reason: 'no_customer_message' };

  if (input.suppressed) return { kind: 'skip', reason: 'agent_suppressed' };

  if (input.trigger === 'rule' && !settings.surveyRuleResolved) {
    return { kind: 'skip', reason: 'rule_resolved' };
  }

  if (input.recentlySurveyed) return { kind: 'skip', reason: 'recently_surveyed' };

  if (input.byEmail) {
    return input.contactEmail
      ? { kind: 'send', delivery: 'email_link' }
      : { kind: 'skip', reason: 'no_address' };
  }

  if (input.channel === 'facebook' || input.channel === 'instagram') {
    return input.metaWindowOpen
      ? { kind: 'send', delivery: 'text_link' }
      : { kind: 'skip', reason: 'window_closed' };
  }

  // Web chat: the row is the delivery.
  return { kind: 'send', delivery: 'text_link' };
}
