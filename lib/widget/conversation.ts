import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  contactIdentities,
  contacts,
  conversationEvents,
  conversations,
  csatSurveys,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { recordAnswer } from '@/lib/csat';
import { wordingRulesById } from '@/lib/csat/rules';
import { ratingLabels, resolveWording, type WordingPair } from '@/lib/csat/wording';
import { preview } from '@/lib/html/sanitize';
import { UNNAMED_SUBJECT } from '@/lib/tickets/customer-text';
import { afterInboundMessage, afterMessageStored } from '@/lib/tickets/lifecycle';
import { reopenResolved } from '@/lib/tickets/reopen';
import { requireDefaultOpenStatusId } from '@/lib/tickets/statuses';
import type { VisitorDetails } from './contact';
import type { Message, WidgetSurvey } from './types';
import { recordIdentityOnConversation } from './identify';
import { findLiveConversation, webchatChannel } from './session';
import { planRouting, routingWindowValues, startRouting } from '@/lib/routing/start';

/**
 * Reading and appending to a visitor's chat.
 *
 * Everything here is reached from unauthenticated endpoints, so every function
 * takes the contact the visitor's token resolved to and scopes its query by it.
 * None of them accept a conversation id from the caller — that would let a
 * visitor read someone else's chat by guessing.
 */

/** The shape is `lib/widget/types.ts`'s, which the browser can name without the driver. */
export type WidgetMessage = Message;

/**
 * Private notes are excluded here, not filtered in the UI.
 *
 * A message that carries a satisfaction survey comes with the survey, so the
 * thread can draw it as a card: its state, and the wording of the rule it
 * went out with, in the language it was sent in, resolved here so the card
 * holds no wording logic of its own. The rule as it reads now, as the survey
 * page reads it: an admin who rewords a rule rewords its open surveys, while
 * the message's body keeps the sentence it was sent with — the price of not
 * copying six strings onto every survey row. The card carries no token. The message's body still holds
 * the survey's link — the visitor's own, and what a widget loaded before the
 * card existed draws — so this is not a way of keeping the link from the
 * browser, only of not needing it there.
 *
 * One statement for the transcript and its surveys, and one more for wording
 * rules only when a survey names one: this runs on every push to every open
 * widget.
 */
export async function listMessages(conversationId: string): Promise<WidgetMessage[]> {
  const rows = await db
    .select({
      id: messages.id,
      direction: messages.direction,
      kind: messages.kind,
      bodyText: messages.bodyText,
      createdAt: messages.createdAt,
      agentName: agents.name,
      surveyId: csatSurveys.id,
      surveyStatus: csatSurveys.status,
      surveyRating: csatSurveys.rating,
      surveyLocale: csatSurveys.locale,
      surveyRuleId: csatSurveys.ruleId,
    })
    .from(messages)
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    // On the conversation as well as the message, so the join is served by
    // the surveys' conversation index rather than a scan for each row.
    .leftJoin(
      csatSurveys,
      and(
        eq(csatSurveys.messageId, messages.id),
        eq(csatSurveys.conversationId, messages.conversationId),
      ),
    )
    .where(
      and(
        eq(messages.conversationId, conversationId),
        // An agent-only note must never reach the widget. Excluding it in the
        // query rather than in the renderer means it is not in the payload at
        // all, so it cannot leak through a devtools panel either.
        eq(messages.kind, 'reply'),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(200);

  const ruleIds = [...new Set(rows.flatMap((row) => (row.surveyRuleId ? [row.surveyRuleId] : [])))];
  const rules = await wordingRulesById(ruleIds);

  return rows.map((row) => ({
    id: row.id,
    from: row.direction === 'inbound' ? 'visitor' : row.agentName ? 'agent' : 'system',
    authorName: row.agentName,
    body: row.bodyText,
    createdAt: row.createdAt.toISOString(),
    survey: row.surveyId
      ? surveyCard(
          {
            id: row.surveyId,
            status: row.surveyStatus,
            rating: row.surveyRating,
            locale: row.surveyLocale,
          },
          row.surveyRuleId ? (rules.get(row.surveyRuleId) ?? null) : null,
        )
      : null,
  }));
}

function surveyCard(
  survey: { id: string; status: string | null; rating: number | null; locale: string | null },
  rule: WordingPair | null,
): WidgetSurvey {
  // Every survey since stage 1 records its language; Arabic, the front door,
  // for one that somehow does not. A rule since deleted is the built-in
  // wording it was a variation of, as on the survey page.
  const locale = survey.locale === 'en' ? 'en' : 'ar';
  const wording = resolveWording(rule, locale);
  return {
    id: survey.id,
    rating: survey.rating,
    expired: survey.status === 'expired' && survey.rating === null,
    locale,
    intro: wording.intro,
    question: wording.question,
    labels: ratingLabels(locale),
    commentPrompt: wording.commentPrompt,
    button: wording.button,
    thanks: wording.thanks,
  };
}

/**
 * Records a visitor's answer from the survey card, if the survey is theirs to
 * answer, and returns the rating it holds afterwards.
 *
 * The visitor's session is the credential here, as it is for reading the
 * chat: the survey must sit on one of the web chat conversations of the
 * contact their token resolved to, so a survey id from anywhere else — a
 * guess, another visitor's — answers nothing. Nor does one a newer survey
 * superseded: the card draws that one closed, and a door that took what the
 * card refuses would be a second opinion. Everything else is `recordAnswer`'s,
 * the one door every answer goes through.
 *
 * The rating returned is the stored one, which is the visitor's own or an
 * earlier answer's — first answer wins — so a card whose first post lost its
 * reply shows what was kept rather than its second tap. Null when there was
 * nothing here for this visitor to answer.
 */
export async function answerSurvey(
  contactId: string,
  surveyId: string,
  rating: number,
  comment: string | null,
): Promise<number | null> {
  const [owned] = await db
    .select({ status: csatSurveys.status })
    .from(csatSurveys)
    .innerJoin(conversations, eq(conversations.id, csatSurveys.conversationId))
    .where(
      and(
        eq(csatSurveys.id, surveyId),
        eq(conversations.requesterContactId, contactId),
        eq(conversations.channel, 'webchat'),
        isNull(conversations.deletedAt),
      ),
    )
    .limit(1);
  if (!owned || (owned.status !== 'sent' && owned.status !== 'answered')) return null;

  await recordAnswer(surveyId, rating, comment, 'widget');

  const [after] = await db
    .select({ rating: csatSurveys.rating })
    .from(csatSurveys)
    .where(eq(csatSurveys.id, surveyId))
    .limit(1);
  return after?.rating ?? null;
}

export type AppendResult = {
  conversationId: string;
  messageId: string;
  createdConversation: boolean;
};

/**
 * Appends a visitor message, opening a conversation if there is not a live one.
 *
 * `lastCustomerMessageAt` is set for consistency with the other channels even
 * though webchat has no 24-hour window — the SLA clock reads it, and leaving it
 * null would make chat conversations look permanently unanswered.
 */
export async function appendVisitorMessage(
  contactId: string,
  body: string,
  meta: { pageUrl?: string | null; userAgent?: string | null } = {},
): Promise<AppendResult> {
  const existing = await findLiveConversation(contactId);
  const channel = await webchatChannel();
  const now = new Date();
  // Before the transaction, which must read nothing on the pool (`lib/routing/start.ts`).
  const routing = existing ? null : await planRouting(channel);

  const result = await db.transaction(async (tx) => {
    let conversationId = existing;
    let createdConversation = false;

    if (!conversationId) {
      const statusId = await requireDefaultOpenStatusId(tx);

      const inserted = await tx
        .insert(conversations)
        .values({
          channel: 'webchat',
          channelId: channel?.id ?? null,
          statusId,
          // Chat has no subject line; the first message is the most useful
          // thing to show in a ticket list.
          subject: preview(body, 80) || UNNAMED_SUBJECT.webchat,
          requesterContactId: contactId,
          groupId: channel?.defaultGroupId ?? null,
          lastMessageAt: now,
          lastCustomerMessageAt: now,
          // Held for the router from the insert (`lib/routing/start.ts`).
          ...routingWindowValues(routing, {}, now),
        })
        .returning({ id: conversations.id });

      conversationId = inserted[0]!.id;
      createdConversation = true;
    } else {
      await reopenIfResolved(tx, conversationId);
    }

    const inserted = await tx
      .insert(messages)
      .values({
        conversationId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contactId,
        bodyText: body,
        deliveryStatus: 'delivered',
        deliveredAt: now,
        meta: { pageUrl: meta.pageUrl ?? null, userAgent: meta.userAgent ?? null },
        createdAt: now,
      })
      .returning({ id: messages.id });

    if (createdConversation) {
      await startRouting(
        tx,
        routing,
        {
          conversationId,
          messageId: inserted[0]!.id,
          groupId: channel?.defaultGroupId ?? null,
        },
        now,
      );
    }

    await tx
      .update(conversations)
      .set({ lastMessageAt: now, lastCustomerMessageAt: now })
      .where(eq(conversations.id, conversationId));

    return { conversationId, messageId: inserted[0]!.id, createdConversation };
  });

  /*
   * Before the automations, so a rule routing on the merchant's account sees the
   * link rather than racing it. Only on creation: an identity that changes under
   * a live conversation is recorded by the identify endpoint itself, and doing
   * it per message would write the same event onto every reply.
   */
  if (result.createdConversation) {
    await recordIdentityOnConversation(result.conversationId, contactId);
  }

  await afterMessageStored({
    conversationId: result.conversationId,
    messageId: result.messageId,
    bodyText: body,
    kind: 'reply',
    direction: 'inbound',
  });

  await afterInboundMessage(result.conversationId, result.createdConversation, now, {
    id: result.messageId,
  });

  return result;
}

/**
 * Records how to reach a visitor who wrote in with nobody available.
 *
 * At least one of `email` and `phone` is present — `parseVisitorDetails` rejects
 * the pair being empty, because a name is not a way back.
 *
 * The address gets a `contact_identities` row so the visitor's later mail lands
 * on this history instead of opening a second customer record. **The phone
 * number does not.** The same argument appears to apply to WhatsApp, but the
 * failure mode is not symmetrical: a mistyped address usually belongs to nobody,
 * while a mistyped Egyptian mobile very likely belongs to a real person, and
 * WhatsApp is this system's busiest channel — so one wrong digit would thread a
 * stranger's future messages onto this contact, along with the transcript that
 * named them. A genuine WhatsApp conversation mints the identity through
 * `resolveContact` on its own.
 *
 * **That does not make the number inert, and it is worth being exact about
 * why.** Both values land on `contacts`, and `mergeCandidates` matches on
 * `primary_email` *and* `primary_phone` — so anything written here is an
 * identity-matching key regardless of whether it also has an identity row, and a
 * visitor who types a real customer's number will surface that customer as a
 * merge suggestion on their own throwaway contact, reason `'phone'`. Nothing
 * merges on its own; `lib/contacts/merge.ts` is explicit that the decision stays
 * with an agent, and this is the same exposure the address beside it has always
 * had. Skipping the identity row narrows the blast radius to a suggestion an
 * agent can decline, rather than a routing rule that silently threads a
 * stranger's inbound messages. It does not remove it.
 */
export async function attachVisitorDetails(
  contactId: string,
  conversationId: string,
  details: VisitorDetails,
): Promise<void> {
  const { name, email, phone } = details;

  await db.transaction(async (tx) => {
    await tx
      .update(contacts)
      .set({
        // Spread rather than assigned, so leaving one field blank does not
        // overwrite a value the contact already has with null.
        ...(email ? { primaryEmail: email } : {}),
        ...(phone ? { primaryPhone: phone } : {}),
        ...(name ? { name } : {}),
      })
      .where(eq(contacts.id, contactId));

    // Conflict means the address already belongs to someone — left alone rather
    // than reassigned, because merging two customers is a decision for an agent.
    if (email) {
      await tx
        .insert(contactIdentities)
        .values({ contactId, channel: 'email', identifier: email, displayName: name })
        .onConflictDoNothing({
          target: [contactIdentities.channel, contactIdentities.identifier],
        });
    }

    await tx.insert(conversationEvents).values({
      conversationId,
      type: 'contact_updated',
      actorLabel: 'webchat',
      data: { ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
    });
  });
}

/**
 * Reopen the conversation if it is resolved.
 *
 * The caller holds only the conversation's id, so its category and reopen count
 * are read here; the reopen itself is the shared one, with the widget's own
 * reason — `visitor_replied`, where every other path says `customer_replied`.
 */
async function reopenIfResolved(tx: typeof db, conversationId: string): Promise<void> {
  const rows = await tx
    .select({ category: ticketStatuses.category, reopenCount: conversations.reopenCount })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (rows[0]?.category !== 'resolved') return;

  await reopenResolved(
    tx,
    { id: conversationId, reopenCount: rows[0].reopenCount },
    { actorLabel: 'webchat', reason: 'visitor_replied' },
  );
}
