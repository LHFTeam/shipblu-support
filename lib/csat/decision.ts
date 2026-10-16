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
 *
 * One thing is not decided here: whether the ticket already carries a survey
 * inside the resurvey window. That is read under a lock on the ticket, at the
 * moment the survey row is written (`sendSurvey`), because two jobs for one
 * ticket can run at once and a check made before either writes lets both
 * through.
 */

/** Who asked for the survey: an agent resolving, a rule resolving, or the sidebar's "Send now". */
export type SurveyTrigger = 'agent' | 'rule' | 'manual';

export type DecisionInput = {
  channel: string;
  statusCategory: string;
  deletedAt: Date | null;
  isSpam: boolean;
  mergedIntoId: string | null;
  /**
   * Whether the customer sent anything on the ticket — words, a photo, a
   * voice note. Not whether they wrote *words*: a customer who sent a photo of
   * the damaged parcel took part, and the rule that looks past our media
   * labels (`carriesCustomerText`) was written to pick a language, not to
   * decide that.
   */
  hasCustomerMessage: boolean;
  suppressed: boolean;
  trigger: SurveyTrigger;
  contactEmail: string | null;
  /**
   * On Facebook and Instagram, whether the ticket is a public comment thread
   * (`rootCommentId` found one). A survey there would be posted on the comment
   * edge, link and all, for anybody reading the post to answer.
   */
  commentThread: boolean;
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
  if (!input.hasCustomerMessage) return { kind: 'skip', reason: 'no_customer_message' };

  if (input.suppressed) return { kind: 'skip', reason: 'agent_suppressed' };

  if (input.trigger === 'rule' && !settings.surveyRuleResolved) {
    return { kind: 'skip', reason: 'rule_resolved' };
  }

  if (input.byEmail) {
    return input.contactEmail
      ? { kind: 'send', delivery: 'email_link' }
      : { kind: 'skip', reason: 'no_address' };
  }

  if (input.channel === 'facebook' || input.channel === 'instagram') {
    // Before the window: a comment thread has no window, which is exactly why
    // `automatedReplyBlocked` lets it through — and why it must not be here.
    if (input.commentThread) return { kind: 'skip', reason: 'comment_thread' };
    return input.metaWindowOpen
      ? { kind: 'send', delivery: 'text_link' }
      : { kind: 'skip', reason: 'window_closed' };
  }

  // Web chat: the row is the delivery.
  return { kind: 'send', delivery: 'text_link' };
}
