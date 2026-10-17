import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, csatSurveys } from '@/db/schema';
import { logger } from '@/lib/log';
import type { NormalisedFeedback } from '@/lib/meta/types';
import { findContactByIdentity } from '@/lib/tickets/contacts';
import {
  automatedReplyBlocked,
  enqueueAutomatedDelivery,
  writeAutomatedReply,
} from '@/lib/tickets/outbound';
import { recordAnswer, type ResponseOutcome } from '@/lib/csat';
import { quickReplyThanks } from './meta-survey';
import { wordingForRule } from './rules';

const log = logger('csat');

/**
 * A satisfaction survey answered on Facebook or Instagram: Messenger's
 * feedback card, or one of the survey's quick replies tapped.
 *
 * The answer names its survey — the card's question id, the button's payload
 * — and anybody can put a survey id in a message, so the id alone is not the
 * credential. The page has its token and the widget the visitor's session;
 * here it is who sent it: the sender's page-scoped id must resolve to the
 * ticket's requester, on the platform the ticket is on. An answer that fails
 * either is dropped, and logged, rather than recorded against somebody
 * else's ticket.
 *
 * Then `recordAnswer`, the one door every answer goes through, with its
 * first-answer-wins rule — which is also what makes the second copy of an
 * Instagram tap, delivered once on each of the two connections, record
 * nothing the second time.
 */
export type FeedbackOutcome = ResponseOutcome | 'unknown_survey' | 'not_requester';

export async function recordMetaFeedback(feedback: NormalisedFeedback): Promise<FeedbackOutcome> {
  const [survey] = await db
    .select({
      id: csatSurveys.id,
      conversationId: csatSurveys.conversationId,
      locale: csatSurveys.locale,
      ruleId: csatSurveys.ruleId,
      channel: conversations.channel,
      requesterContactId: conversations.requesterContactId,
      externalId: conversations.externalId,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
      deletedAt: conversations.deletedAt,
    })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(eq(csatSurveys.id, feedback.surveyId))
    .limit(1);
  if (!survey || survey.channel !== feedback.platform) return 'unknown_survey';

  const contactId = await findContactByIdentity(feedback.platform, feedback.from);
  if (!contactId || contactId !== survey.requesterContactId) return 'not_requester';

  const outcome = await recordAnswer(survey.id, feedback.rating, feedback.comment, feedback.source);

  // Messenger's card thanks the customer itself. A tap has nothing after it,
  // so the first one is answered — and only the first: a second tap, or the
  // other connection's copy of this one, is `ignored` above.
  if (outcome === 'recorded' && feedback.source === 'meta_quick_reply' && !survey.deletedAt) {
    try {
      await thankForTap(survey);
    } catch (error) {
      // The rating is recorded, which is what the customer did; a thanks lost
      // to a failed write is not worth failing the delivery that carried it,
      // whose retry would find the survey answered and thank nobody anyway.
      log.error(`could not thank the customer for survey ${survey.id}`, error);
    }
  }

  return outcome;
}

/**
 * The thanks, and where to put anything else (`quickReplyThanks`), as an
 * automated message through the door every automated sender uses — so on a
 * channel whose window has closed it is not written at all. The window is the
 * customer's last *message*: the tap opens Meta's, but it is an answer and not
 * a message, so it moves nothing here, and a survey tapped more than a day
 * after the customer last wrote is recorded without a reply.
 */
async function thankForTap(survey: {
  id: string;
  conversationId: string;
  locale: string | null;
  ruleId: string | null;
  channel: string;
  externalId: string | null;
  lastCustomerMessageAt: Date | null;
}): Promise<void> {
  if (automatedReplyBlocked(survey)) return;

  const locale = survey.locale === 'ar' ? 'ar' : 'en';
  const wording = await wordingForRule(survey.ruleId, locale);

  const messageId = await writeAutomatedReply(
    db,
    {
      conversationId: survey.conversationId,
      channel: survey.channel,
      requesterEmail: null,
      bodyText: quickReplyThanks(wording, locale),
      bodyHtml: null,
      actorLabel: 'csat',
      eventType: 'csat_thanked',
      eventData: { surveyId: survey.id },
    },
    // Not the acknowledgement a rule looks for, for the reason the survey
    // itself is not one.
    { stampFirstAutoReply: false },
  );
  await enqueueAutomatedDelivery(survey.channel, messageId, 50);
}
