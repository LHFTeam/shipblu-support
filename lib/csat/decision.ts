import type { SurveyDelivery } from './delivery';
import type { CsatChannels, CsatSettings } from './settings';
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
 * happened to fire first. A channel nobody surveys comes before that, because
 * no switch would change its answer.
 *
 * Two things are not decided here, because they can change between this read
 * and the write: whether the ticket is still resolved and not suppressed, and
 * whether it already carries a survey inside the resurvey window. `sendSurvey`
 * re-reads both under a lock on the ticket row.
 */

/**
 * Who asked for the survey: a resolve, by an agent or a rule, or the
 * sidebar's "Send now". It decides the delay and whether a duplicate is
 * answered on the ticket; who resolved the ticket is read off its timeline
 * (`resolvedByRule` in the job), never off the trigger.
 */
export const SURVEY_TRIGGERS = ['agent', 'rule', 'manual'] as const;
export type SurveyTrigger = (typeof SURVEY_TRIGGERS)[number];

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
  /**
   * Whether a rule, not a person, resolved the ticket — read off the ticket's
   * timeline (`resolvedByRule` in the job) rather than off who queued the
   * job, because a ticket resolved by an agent, reopened and re-resolved by
   * a rule inside the delay has two jobs with two triggers and one truth.
   * Which is also why the trigger is not an input here: it decides the delay
   * and whether a duplicate is answered on the ticket, both of them the job's.
   */
  resolvedByRule: boolean;
  /** `lacksEmailRecipient`: written as an email, with nowhere to send it. */
  lacksRecipient: boolean;
  /**
   * On Facebook and Instagram, whether the ticket is a public comment thread
   * (`rootCommentId` found one). A survey there would be posted on the comment
   * edge, link and all, for anybody reading the post to answer.
   */
  commentThread: boolean;
  /**
   * On Facebook and Instagram, whether an automated message can send right
   * now (`automatedReplyBlocked` answered null): Instagram's quick replies
   * go inside this or not at all. Ignored elsewhere.
   */
  metaWindowOpen: boolean;
  /**
   * On Facebook, whether Messenger's feedback card can send right now —
   * the same question asked for the card, which has seven days rather than
   * one (`automatedReplyBlocked(…, 'feedback_template')`). Ignored elsewhere.
   */
  feedbackWindowOpen: boolean;
  /** Whether the channel is one nobody on the team writes to (`isReadOnlyChannel`). */
  readOnly: boolean;
  /** Whether a message on this channel is written as an email (`sendsByEmail`). */
  byEmail: boolean;
};

export type Decision =
  | { kind: 'send'; delivery: SurveyDelivery }
  | { kind: 'skip'; reason: SkipReason }
  /** The ticket is gone — deleted, spam, merged away — and nothing is written. */
  | { kind: 'drop' };

/**
 * Which admin switch a channel is behind, or null for a channel no survey is
 * sent on. `portal` rides email's switch because it rides email's carrier;
 * WhatsApp and the bot have none, for the reason `plans/csat.md` gives.
 */
export function channelSwitch(channel: string): keyof CsatChannels | null {
  switch (channel) {
    case 'email':
    case 'portal':
      return 'email';
    case 'webchat':
    case 'facebook':
    case 'instagram':
    case 'api':
      return channel;
    default:
      return null;
  }
}

/**
 * A web chat that is closed is not the visitor's any more: the widget opens a
 * fresh conversation in its place (`findLiveConversation`), so a survey
 * written onto this one is one nobody can see, recorded as sent. Asked by the
 * decision, again under the lock in `sendSurvey`, and by the ticket sidebar
 * before it offers "Send now" — one question, so the three cannot disagree.
 */
export function isClosedChat(channel: string, statusCategory: string): boolean {
  return channel === 'webchat' && statusCategory === 'closed';
}

/** Whether the admin has surveys on for this channel; false for one with no switch. */
export function channelSurveyed(settings: CsatSettings, channel: string): boolean {
  const key = channelSwitch(channel);
  return key !== null && settings.channels[key];
}

/**
 * Whether a survey could go out on a ticket's channel right now, for the
 * sidebar: `off` and `channel_off` are switches an admin can flip,
 * `unsupported` a channel no survey goes out on at all, and `unknown` settings
 * that could not be read.
 */
export type SurveyAvailability = 'on' | 'off' | 'channel_off' | 'unsupported' | 'unknown';

/**
 * `scheduleSurvey`'s refusals for a channel, the channel with no switch first:
 * no setting changes that one, so it is the answer whatever the switch says.
 * Settings that could not be read are `unknown`, never `off`, for the reason
 * `scheduleSurvey` gives — the agent is not told a switch is off that nobody
 * turned off.
 */
export function surveyAvailability(
  settings: CsatSettings | null,
  channel: string,
): SurveyAvailability {
  const key = channelSwitch(channel);
  if (key === null) return 'unsupported';
  if (settings === null) return 'unknown';
  if (!settings.enabled) return 'off';
  return settings.channels[key] ? 'on' : 'channel_off';
}

export function decideSurvey(input: DecisionInput, settings: CsatSettings): Decision {
  if (input.deletedAt || input.isSpam || input.mergedIntoId) return { kind: 'drop' };

  // Asking the customer to rate our support on the strength of a conversation
  // the team never had would be asking about someone else's work — whatever
  // any switch says.
  if (input.readOnly) return { kind: 'skip', reason: 'read_only_channel' };

  if (!settings.enabled) return { kind: 'skip', reason: 'csat_off' };

  const key = channelSwitch(input.channel);
  if (key === null) return { kind: 'skip', reason: 'channel_unsupported' };
  if (!settings.channels[key]) return { kind: 'skip', reason: 'channel_off' };

  // The customer came back in the grace period: they want an answer, not a
  // survey. The next resolution schedules a new one.
  if (input.statusCategory !== 'resolved' && input.statusCategory !== 'closed') {
    return { kind: 'skip', reason: 'reopened' };
  }

  // An agent-opened ticket the customer never answered has nothing to rate.
  if (!input.hasCustomerMessage) return { kind: 'skip', reason: 'no_customer_message' };

  if (input.suppressed) return { kind: 'skip', reason: 'agent_suppressed' };

  if (input.resolvedByRule && !settings.surveyRuleResolved) {
    return { kind: 'skip', reason: 'rule_resolved' };
  }

  if (input.byEmail) {
    return input.lacksRecipient
      ? { kind: 'skip', reason: 'no_address' }
      : { kind: 'send', delivery: 'email_link' };
  }

  if (input.channel === 'facebook' || input.channel === 'instagram') {
    // Before the window: a comment thread has no window, which is exactly why
    // `automatedReplyBlocked` lets it through — and why it must not be here.
    if (input.commentThread) return { kind: 'skip', reason: 'comment_thread' };

    if (input.channel === 'facebook') {
      // Messenger's own survey card, for the seven days its tag allows — which
      // Graph refuses without a privacy link. With none, the 24 hours still
      // take the rating buttons Instagram gets, which need no link; past
      // them, the missing link is the reason, because with one the card
      // would have gone.
      if (settings.privacyUrl && input.feedbackWindowOpen) {
        return { kind: 'send', delivery: 'meta_template' };
      }
      if (input.metaWindowOpen) return { kind: 'send', delivery: 'meta_quick_reply' };
      return {
        kind: 'skip',
        reason:
          settings.privacyUrl || !input.feedbackWindowOpen ? 'window_closed' : 'no_privacy_url',
      };
    }

    // Instagram has no card; five quick replies under the question, which
    // no tag carries past the 24 hours.
    return input.metaWindowOpen
      ? { kind: 'send', delivery: 'meta_quick_reply' }
      : { kind: 'skip', reason: 'window_closed' };
  }

  // Web chat: the row is the delivery, and the widget draws it as a card the
  // visitor answers without leaving the chat. The message keeps the link, for
  // the console's timeline and for a widget loaded before the card existed.
  // A closed chat is a delivery that cannot happen, like an address that is
  // not there or a window that has shut, so it is said here with them —
  // after the agent's and the rule's reasons, which say more about the ticket
  // than which conversation the widget happens to show.
  return isClosedChat(input.channel, input.statusCategory)
    ? { kind: 'skip', reason: 'chat_closed' }
    : { kind: 'send', delivery: 'widget_card' };
}
