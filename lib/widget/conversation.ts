import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  attachments,
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
import { webchatFilesStandIn } from '@/lib/chat/stand-ins';
import { preview } from '@/lib/html/sanitize';
import { logger } from '@/lib/log';
import { buildAttachmentPath, removeObjects, uploadObject } from '@/lib/storage';
import { UNNAMED_SUBJECT } from '@/lib/tickets/customer-text';
import { isMediaStandIn } from '@/lib/tickets/message-media';
import { afterInboundMessage, afterMessageStored } from '@/lib/tickets/lifecycle';
import { reopenResolved } from '@/lib/tickets/reopen';
import { requireDefaultOpenStatusId } from '@/lib/tickets/statuses';
import type { VisitorDetails } from './contact';
import { widgetFileUrl } from './file-links';
import type { WidgetFileKind } from './files';
import type { Message, WidgetAttachment, WidgetSurvey } from './types';
import { recordIdentityOnConversation } from './identify';
import { findLiveConversation, webchatChannel } from './session';
import { planRouting, routingWindowValues, startRouting } from '@/lib/routing/start';

const log = logger('widget_files');

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
      meta: messages.meta,
      createdAt: messages.createdAt,
      agentName: agents.name,
      files: messageFiles,
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
  // One instant for every link in the transcript, so they share one expiry.
  const now = new Date();

  return rows.map((row) => {
    const files = (row.files ?? []).map((file) => ({ ...file, url: widgetFileUrl(file.id, now) }));
    return {
      id: row.id,
      from: row.direction === 'inbound' ? 'visitor' : row.agentName ? 'agent' : 'system',
      authorName: row.agentName,
      body: standsIn(row, files) ? '' : row.bodyText,
      createdAt: row.createdAt.toISOString(),
      attachments: files,
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
    };
  });
}

/**
 * A message's files, as one JSON array in the transcript's own statement.
 *
 * A subquery rather than a join, because a join returns a row per file and the
 * transcript's `limit` counts rows: a message with five photos would spend five
 * of them, and the cut could fall between one message's files. And rather than
 * a second statement, because this runs on every push to every open widget.
 * Null for a message with none, which the reader takes as an empty list.
 *
 * In the order the visitor attached them, which `appendVisitorMessage` writes
 * as each file's `created_at` — the order the console's thread reads too. The
 * stored key, which ends in the file's place, breaks a tie anything else left.
 * An inline image, an email's `cid:` part, is part of a body the widget never
 * draws, so it is left out.
 */
const messageFiles = sql<Omit<WidgetAttachment, 'url'>[] | null>`(
  select json_agg(
    json_build_object(
      'id', ${attachments.id},
      'filename', ${attachments.filename},
      'contentType', ${attachments.contentType},
      'sizeBytes', ${attachments.sizeBytes}
    )
    order by ${attachments.createdAt}, ${attachments.storagePath}
  )
  from ${attachments}
  where ${attachments.messageId} = ${messages.id} and not ${attachments.isInline}
)`;

/**
 * Whether a visitor's words are only the stand-in the widget wrote for their
 * files, which the thread draws in their place — the console's own test
 * (`isMediaStandIn`), so the two surfaces leave out the same line. Only the
 * visitor's messages carry one, and a widget message has no HTML body.
 */
function standsIn(
  row: { direction: string; bodyText: string; meta: Record<string, unknown> },
  files: readonly { id: string; contentType: string }[],
): boolean {
  return (
    row.direction === 'inbound' &&
    files.length > 0 &&
    isMediaStandIn({ bodyText: row.bodyText, bodyHtml: null, meta: row.meta, attachments: files })
  );
}

/**
 * The stored key of a file a widget link may still open, or null.
 *
 * Which file a visitor may open is decided when the link is signed: only the
 * transcript signs one (`widgetFileUrl`), and only for the files of the
 * visitor's own chat. This is what can have changed since. The file must still
 * hang off a `reply` on a web chat conversation that is not deleted — so a
 * deleted ticket's links stop working before they expire, and a note's file,
 * which the transcript leaves out with the note, is never reachable even
 * through a link signed for it some other way. A side conversation's file has
 * no `message_id` and is never matched.
 */
export async function widgetAttachmentPath(attachmentId: string): Promise<string | null> {
  const [row] = await db
    .select({ path: attachments.storagePath })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(messages.kind, 'reply'),
        eq(conversations.channel, 'webchat'),
        isNull(conversations.deletedAt),
      ),
    )
    .limit(1);
  return row?.path ?? null;
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
 * A file the visitor attached, read and judged by the route: its type is the
 * server's reading of the bytes (`sniffWidgetFile`), its name already cleaned
 * (`cleanFilename`).
 */
export type VisitorUpload = {
  filename: string;
  contentType: string;
  kind: WidgetFileKind;
  extension: string;
  bytes: Buffer;
};

/** A file that could not be stored, so the message it came with was not either. */
export class VisitorUploadFailed extends Error {}

type StoredUpload = Omit<VisitorUpload, 'bytes' | 'extension'> & {
  path: string;
  checksum: string;
  sizeBytes: number;
};

/**
 * Appends a visitor message, opening a conversation if there is not a live one.
 *
 * `lastCustomerMessageAt` is set for consistency with the other channels even
 * though webchat has no 24-hour window — the SLA clock reads it, and leaving it
 * null would make chat conversations look permanently unanswered.
 *
 * **A message and its files are stored together or not at all**, which is the
 * opposite of a ticket form's order (`lib/forms/attachments.ts`), for a reason
 * that belongs to a chat. A form's answers are worth keeping when a photo fails
 * to upload, and the customer has left by then, so the form keeps the ticket
 * and writes a note asking for the photo. In the widget the visitor is still
 * there: refusing the send puts the words and the files back in the composer
 * to try again, where a message stored without its photo would leave the agent
 * reading "here is the damage" over nothing, and the inbox card saying
 * `[image]` about a file that does not exist.
 *
 * So the files go to Storage first, under ids named before anything is
 * written, and their rows are inserted in the transaction that inserts the
 * message — after which the live update that tells the console about the
 * message also finds its files. A failed upload stores nothing and throws
 * `VisitorUploadFailed`; a failed transaction removes the objects it would
 * have referenced. A file sent with no words gets the stand-in every chat's
 * media gets (`webchatFilesStandIn`), so the subject, the inbox card and search
 * have something to read; the threads leave it out (`isMediaStandIn`).
 *
 * **Everything about the message is read once the files are stored**: which
 * conversation is live, and the instant the message happened. An upload of a
 * video takes seconds, and an instant taken before it put the message behind
 * an agent's reply that landed during it — `last_customer_message_at` older
 * than `last_agent_message_at`, so no reply clock started, and both threads
 * drawing the video above the answer to it. A conversation closed meanwhile
 * gets a new one beside it, as a message arriving a moment later would. The
 * keys already written name the conversation looked for first, which nothing
 * reads them by: the rows hold the key.
 */
export async function appendVisitorMessage(
  contactId: string,
  body: string,
  meta: { pageUrl?: string | null; userAgent?: string | null } = {},
  files: readonly VisitorUpload[] = [],
): Promise<AppendResult> {
  const messageId = randomUUID();
  const text = body || webchatFilesStandIn(files);

  let stored: StoredUpload[] = [];
  /** The conversation the keys name, and whether it was a new id, not a live ticket's. */
  let storedUnder: { id: string; fresh: boolean } | null = null;
  if (files.length > 0) {
    const live = await findLiveConversation(contactId);
    storedUnder = live ? { id: live, fresh: false } : { id: randomUUID(), fresh: true };
    stored = await storeVisitorFiles(storedUnder.id, messageId, files);
  }

  const existing = await findLiveConversation(contactId);
  const channel = await webchatChannel();
  // Before the transaction, which must read nothing on the pool (`lib/routing/start.ts`).
  const routing = existing ? null : await planRouting(channel);
  // A new conversation takes the id its files were stored under when that was
  // a new id too, so a photo-first chat's keys name its own ticket. One that
  // was a live ticket's, closed during the upload, is that ticket's id still.
  const conversationId = existing ?? (storedUnder?.fresh ? storedUnder.id : randomUUID());
  const now = new Date();

  let result: AppendResult;
  try {
    result = await db.transaction(async (tx) => {
      if (!existing) {
        const statusId = await requireDefaultOpenStatusId(tx);

        await tx.insert(conversations).values({
          id: conversationId,
          channel: 'webchat',
          channelId: channel?.id ?? null,
          statusId,
          // Chat has no subject line; the first message is the most useful
          // thing to show in a ticket list.
          subject: preview(text, 80) || UNNAMED_SUBJECT.webchat,
          requesterContactId: contactId,
          groupId: channel?.defaultGroupId ?? null,
          lastMessageAt: now,
          lastCustomerMessageAt: now,
          // Held for the router from the insert (`lib/routing/start.ts`).
          ...routingWindowValues(routing, {}, now),
        });
      } else {
        await reopenIfResolved(tx, conversationId);
      }

      await tx.insert(messages).values({
        id: messageId,
        conversationId,
        direction: 'inbound',
        kind: 'reply',
        authorContactId: contactId,
        bodyText: text,
        deliveryStatus: 'delivered',
        deliveredAt: now,
        meta: {
          pageUrl: meta.pageUrl ?? null,
          userAgent: meta.userAgent ?? null,
          // What was sent, for the stand-in's rebuild (`isMediaStandIn`).
          ...(stored.length > 0
            ? { webchatFiles: stored.map(({ kind, filename }) => ({ kind, filename })) }
            : {}),
        },
        createdAt: now,
      });

      if (stored.length > 0) {
        await tx.insert(attachments).values(
          stored.map((file, index) => ({
            messageId,
            storagePath: file.path,
            // Display only, never a path segment — the key is derived from ids.
            filename: file.filename,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            checksum: file.checksum,
            // A millisecond apart, in the order attached: one statement would
            // give them one `now()`, and the console's thread breaks that tie
            // by a random id, so an agent read "the first shows the box" under
            // whichever photo sorted first.
            createdAt: new Date(now.getTime() + index),
          })),
        );
      }

      if (!existing) {
        await startRouting(
          tx,
          routing,
          { conversationId, messageId, groupId: channel?.defaultGroupId ?? null },
          now,
        );
      }

      await tx
        .update(conversations)
        .set({ lastMessageAt: now, lastCustomerMessageAt: now })
        .where(eq(conversations.id, conversationId));

      return { conversationId, messageId, createdConversation: !existing };
    });
  } catch (error) {
    if (stored.length === 0) throw error;
    // A transaction can fail after its COMMIT was sent — the connection lost
    // before the answer — and then it may have committed (`db/client.ts`). Its
    // files are then on a stored message, and removing them would leave the
    // ticket with links to nothing. So the message is looked for by the id it
    // was given; found, the send succeeded, and the rest of it runs.
    const outcome = await messageExists(messageId).catch(() => 'unknown' as const);
    if (outcome === true) {
      log.warn(`a transaction answered with an error after storing ${messageId}; kept its files`);
      result = { conversationId, messageId, createdConversation: !existing };
    } else {
      // Unknown is kept as well: an object nothing references costs bytes,
      // one a stored message references and that is gone is a broken file.
      if (outcome === false)
        await discardPaths(
          stored.map((file) => file.path),
          conversationId,
        );
      else
        log.warn(`could not tell whether ${messageId} was stored; kept ${stored.length} objects`);
      throw error;
    }
  }

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
    bodyText: text,
    kind: 'reply',
    direction: 'inbound',
  });

  await afterInboundMessage(result.conversationId, result.createdConversation, now, {
    id: result.messageId,
  });

  return result;
}

async function messageExists(messageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return row !== undefined;
}

/**
 * Puts a message's files in Storage, all at once, and either every one is
 * there afterwards or none is.
 *
 * The `-index` in the key is what keeps two files on one message from writing
 * the same object (`buildAttachmentPath` keys on one id), as it is for a form's.
 * The extension comes from the type the bytes were read as, never from the
 * name the visitor's file had.
 *
 * On a failure every key is removed, the failed ones included: an upload that
 * timed out, or answered with a gateway's error, may still have been written,
 * and its key — under a conversation id no row may ever hold — would otherwise
 * be customer content that no purge could find. Removing a key that was never
 * written succeeds. One written after the removal is not caught here, which is
 * why the failure's line names every key.
 */
async function storeVisitorFiles(
  conversationId: string,
  messageId: string,
  files: readonly VisitorUpload[],
): Promise<StoredUpload[]> {
  const paths = files.map((file, index) =>
    buildAttachmentPath(conversationId, `${messageId}-${index}`, `file.${file.extension}`),
  );
  const settled = await Promise.allSettled(
    files.map(async (file, index) => {
      const object = await uploadObject(paths[index]!, file.bytes, file.contentType);
      return {
        path: object.path,
        checksum: object.checksum,
        sizeBytes: object.sizeBytes,
        filename: file.filename,
        contentType: file.contentType,
        kind: file.kind,
      };
    }),
  );

  const failure = settled.find((outcome) => outcome.status === 'rejected');
  if (failure) {
    log.error(
      `could not store a visitor's file on ${conversationId}, removing ${paths.join(', ')}`,
      failure.reason,
    );
    await discardPaths(paths, conversationId);
    throw new VisitorUploadFailed('a file could not be stored', { cause: failure.reason });
  }
  return settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
}

/**
 * Removes objects no row will reference. Never throws — `removeObjects` does
 * not — because the caller is already answering a failure, and a leftover is
 * bytes in a private bucket nobody can reach, which the log names.
 */
async function discardPaths(paths: readonly string[], conversationId: string) {
  if (paths.length === 0) return;
  const { failed } = await removeObjects([...paths]);
  if (failed.length > 0) {
    log.warn(
      `left ${failed.length} unreferenced objects on ${conversationId}: ${failed.join(', ')}`,
    );
  }
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
