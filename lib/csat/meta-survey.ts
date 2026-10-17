import type { FeedbackCard } from '@/lib/meta/feedback-template';
import type { RatingLabels } from '@/lib/meta/quick-reply-survey';
import type { CsatSettings } from './settings';
import { ratingLabels, surveyText, type Wording, type WordingLocale } from './wording';

/**
 * The survey's message on Facebook and Instagram, as the survey job writes it
 * and `send_meta` carries it.
 *
 * Pure. Everything the carrier needs is frozen onto the message row's `meta`
 * when the survey is written — the card's words, the privacy link, the five
 * labels — so `send_meta` builds the request from the row alone, and the
 * console's timeline, the row and what Meta was sent are one wording rather
 * than three reads of a rule that can change between them. The text is the
 * prompt the buttons sit under, and on Messenger's card, which draws its own
 * words, what the timeline shows for it.
 */

/**
 * The card's button, which opens Messenger's question sheet — the sheet has
 * its own Submit. Not the rule's `button`, which is the page's and the chat
 * card's confirm ("Send"): on the card it would read as sending something it
 * does not. Within Meta's 20 characters, and a noun in Arabic rather than an
 * imperative, as everything the customer reads here is.
 */
const CARD_BUTTON: Record<WordingLocale, string> = {
  en: 'Rate our support',
  ar: 'تقييم الخدمة',
};

/** What `send_meta` reads off a survey message's `meta`. */
export type MetaSurveyMeta =
  | { sendKind: 'feedback_template'; card: FeedbackCard; labels: RatingLabels }
  | { sendKind: 'quick_reply_survey'; labels: RatingLabels };

/**
 * The row's `meta` whole: the above, and the survey's id, which `sendSurvey`
 * puts beside it on every survey message. `send_meta` names its fields from
 * here, so the writer and the reader are one type.
 */
export type SurveyMessageMeta = MetaSurveyMeta & { csatSurveyId: string };

export function metaSurveyMessage(
  wording: Wording,
  locale: WordingLocale,
  delivery: 'meta_template' | 'meta_quick_reply',
  settings: Pick<CsatSettings, 'privacyUrl' | 'metaExpiresInDays'>,
): { text: string; html: null; meta: MetaSurveyMeta } {
  const text = surveyText(wording, null);
  // The card's fallback is these same five, so it carries them too.
  const labels = ratingLabels(locale);

  if (delivery === 'meta_quick_reply') {
    return { text, html: null, meta: { sendKind: 'quick_reply_survey', labels } };
  }
  // `decideSurvey` never sends the card without one; a caller that got here
  // otherwise would have written a card Graph refuses.
  if (!settings.privacyUrl) throw new Error('the feedback card needs a privacy link');

  return {
    text,
    html: null,
    meta: {
      sendKind: 'feedback_template',
      card: {
        title: wording.intro,
        subtitle: wording.subtitle,
        button: CARD_BUTTON[locale],
        question: wording.question,
        placeholder: wording.commentPrompt,
        privacyUrl: settings.privacyUrl,
        expiresInDays: settings.metaExpiresInDays,
      },
      labels,
    },
  };
}
