import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversationEvents, conversations, messages } from '@/db/schema';
import { normaliseIdentifier } from '@/lib/auth/normalise';
import {
  findCoexistenceChannel,
  recordContactSync,
  recordHistoryDeclined,
  recordHistoryProgress,
} from '@/lib/whatsapp/coexistence-state';
import type {
  NormalisedContactSync,
  NormalisedHistoryChunk,
  NormalisedHistoryMedia,
  NormalisedHistoryMessage,
} from '@/lib/whatsapp/types';
import { applyChannelProfile, resolveContact } from './contacts';
import { subjectFrom } from './ingest-whatsapp';
import { latest } from './latest';
import { requireResolvedStatusId } from './statuses';

/**
 * A WhatsApp Business app number's past, copied in after it was connected
 * through coexistence: its chat history and its address book.
 *
 * **History is a record, not traffic.** Each customer's thread becomes one
 * resolved conversation, `source_system = 'import'`, holding both sides of it —
 * the customer's messages and the business's replies from the phone. None of
 * the machinery a live message sets off runs for it: no SLA clock, no
 * automation, no out-of-hours reply, no categorisation, no shipment linking, no
 * media download, and no 24-hour window. Every one of those is a decision about
 * a conversation happening now, and six months of finished chats arriving in
 * ten minutes would otherwise breach every SLA at once, auto-reply to
 * customers about messages they sent in April, and file a quarter of support
 * demand into today's category report.
 *
 * So the columns those decisions read stay empty: `last_customer_message_at`
 * (which opens the window — an agent writing on an imported ticket gets the
 * template picker, which is the truth), `last_agent_message_at`,
 * `first_responded_at` and `resolved_at` (no rollup counts an import as a
 * response or a resolution). `last_message_at` cannot be — it is not null —
 * and holds the thread's newest message, which is also what sorts it in the
 * customer's history. And a live message never continues an imported
 * conversation (`liveConversationFilter`): reopening one would start the
 * team's clocks against a ticket created months ago.
 *
 * Idempotent, because Meta redelivers and chunks arrive in no order and are
 * processed concurrently: the conversation is found by `(import,
 * external_id)`, each message by its wamid, and both inserts skip what exists.
 * A message the number also delivered live — the last day of history overlaps
 * the hours after connecting — keeps the live row and is skipped here.
 */

export type HistoryChunkResult =
  | { skipped: 'not_coexistence' }
  | { skipped: 'declined' }
  | { skipped: null; threads: number; created: number; inserted: number; duplicates: number };

/** Statement-sized batches: well under Postgres's 65,535 bind parameters. */
const INSERT_BATCH = 500;

export async function ingestWhatsAppHistoryChunk(
  chunk: NormalisedHistoryChunk,
  receivedAt: Date,
): Promise<HistoryChunkResult> {
  // A number not connected this way: Meta copies history only for a number it
  // onboarded, so this is a WABA shared with something else. Nothing here asked.
  const channel = await findCoexistenceChannel(chunk.phoneNumberId);
  if (!channel) return { skipped: 'not_coexistence' };

  if (chunk.declined) {
    await recordHistoryDeclined(channel.id, chunk.declined.code, receivedAt);
    return { skipped: 'declined' };
  }

  const threads = new Map<string, NormalisedHistoryMessage[]>();
  for (const message of chunk.messages) {
    const customer = normaliseIdentifier('whatsapp', message.customer);
    if (!customer) continue;
    const thread = threads.get(customer) ?? [];
    thread.push(message);
    threads.set(customer, thread);
  }

  let created = 0;
  let inserted = 0;
  let duplicates = 0;

  for (const [customer, thread] of threads) {
    const outcome = await importThread({
      channel,
      phoneNumberId: chunk.phoneNumberId!,
      phase: chunk.phase,
      customer,
      thread: thread.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime()),
    });
    if (outcome.created) created += 1;
    inserted += outcome.inserted;
    duplicates += outcome.duplicates;
  }

  // Counted once the chunk's rows are in, so progress never runs ahead of
  // what an agent can find.
  await recordHistoryProgress(
    channel.id,
    { phase: chunk.phase, progress: chunk.progress },
    receivedAt,
  );

  return { skipped: null, threads: threads.size, created, inserted, duplicates };
}

async function importThread(input: {
  channel: { id: string; defaultGroupId: string | null };
  phoneNumberId: string;
  phase: number | null;
  customer: string;
  thread: NormalisedHistoryMessage[];
}): Promise<{ created: boolean; inserted: number; duplicates: number }> {
  const { channel, customer, thread } = input;

  // What is already stored — delivered live, or by an earlier delivery of this
  // chunk. Read first so a thread that is entirely known never creates an
  // empty conversation; the inserts below skip the rest again under a race.
  const known = new Set(
    (
      await db
        .select({ wamid: messages.channelMessageId })
        .from(messages)
        .where(
          inArray(
            messages.channelMessageId,
            thread.map((message) => message.wamid),
          ),
        )
    ).map((row) => row.wamid),
  );
  const fresh = thread.filter((message) => !known.has(message.wamid));
  if (fresh.length === 0) return { created: false, inserted: 0, duplicates: thread.length };

  const { contactId } = await resolveContact({ channel: 'whatsapp', identifier: customer });
  const externalId = `whatsapp:history:${input.phoneNumberId}:${customer}`;
  const earliest = fresh[0]!.sentAt;
  const newest = fresh[fresh.length - 1]!.sentAt;

  return db.transaction(async (tx) => {
    const statusId = await requireResolvedStatusId(tx);
    const opening = fresh.find((message) => message.direction === 'inbound') ?? fresh[0]!;

    const [inserted] = await tx
      .insert(conversations)
      .values({
        channel: 'whatsapp',
        channelId: channel.id,
        statusId,
        subject: subjectFrom(opening.text),
        requesterContactId: contactId,
        groupId: channel.defaultGroupId,
        lastMessageAt: newest,
        sourceSystem: 'import',
        externalId,
        createdAt: earliest,
      })
      // `conversations_external_idx`: this thread, from another chunk or an
      // earlier delivery of this one.
      .onConflictDoNothing()
      .returning({ id: conversations.id });

    let conversationId: string;
    if (inserted) {
      conversationId = inserted.id;
      await tx.insert(conversationEvents).values({
        conversationId,
        type: 'history_imported',
        actorLabel: 'whatsapp_history',
        data: { phoneNumberId: input.phoneNumberId, phase: input.phase },
      });
    } else {
      const [existing] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.sourceSystem, 'import'), eq(conversations.externalId, externalId)),
        )
        .limit(1);
      if (!existing) throw new Error(`history conversation ${externalId} vanished mid-import`);
      conversationId = existing.id;
      // Chunks arrive in no order, and a thread spans the phases: the
      // conversation starts at its earliest message and sorts by its newest,
      // whichever chunk brought them.
      await tx
        .update(conversations)
        .set({
          createdAt: sql`least(${conversations.createdAt}, ${earliest.toISOString()}::timestamptz)`,
          lastMessageAt: latest(conversations.lastMessageAt, newest),
        })
        .where(eq(conversations.id, conversationId));
    }

    let written = 0;
    for (let start = 0; start < fresh.length; start += INSERT_BATCH) {
      const rows = await tx
        .insert(messages)
        .values(
          fresh
            .slice(start, start + INSERT_BATCH)
            .map((message) => historyRow(message, conversationId, contactId, input.phoneNumberId)),
        )
        // Untargeted: a wamid stored live since the read above, or this
        // message from a concurrent delivery — either index, skipped.
        .onConflictDoNothing()
        .returning({ id: messages.id });
      written += rows.length;
    }

    return {
      created: inserted !== undefined,
      inserted: written,
      duplicates: thread.length - written,
    };
  });
}

/** Meta's word for what the phone knows of a sent message, as ours. */
function deliveryStatusOf(phoneStatus: string | null): 'sent' | 'delivered' | 'read' | 'failed' {
  switch (phoneStatus?.toUpperCase()) {
    case 'READ':
    case 'PLAYED':
      return 'read';
    case 'DELIVERED':
      return 'delivered';
    case 'ERROR':
    case 'FAILED':
      return 'failed';
    default:
      return 'sent';
  }
}

function historyRow(
  message: NormalisedHistoryMessage,
  conversationId: string,
  contactId: string,
  phoneNumberId: string,
): typeof messages.$inferInsert {
  const inbound = message.direction === 'inbound';
  const from = typeof message.raw.from === 'string' ? message.raw.from : null;

  return {
    conversationId,
    direction: message.direction,
    kind: 'reply',
    // The business's replies have no author: nobody here wrote them, and the
    // timeline labels them as the Business app, as it does a live echo.
    authorContactId: inbound ? contactId : null,
    bodyText: message.text,
    bodyHtml: null,
    rawBody: JSON.stringify(message.raw),
    channelMessageId: message.wamid,
    inReplyTo: message.replyToWamid,
    fromAddress: inbound ? message.customer : from,
    toAddresses: inbound ? [] : [message.customer],
    deliveryStatus: inbound ? 'delivered' : deliveryStatusOf(message.phoneStatus),
    deliveredAt: inbound ? message.sentAt : null,
    meta: {
      whatsappType: message.type,
      phoneNumberId,
      history: true,
      ...(inbound ? {} : { echo: true, echoSource: 'business_app' }),
      ...(message.phoneStatus ? { phoneStatus: message.phoneStatus } : {}),
      // The phone had a file here; the copy names it and does not carry it.
      ...(message.mediaPlaceholder ? { mediaPlaceholder: true } : {}),
      ...(message.location ? { location: message.location } : {}),
    },
    sourceSystem: 'import',
    externalId: message.wamid,
    createdAt: message.sentAt,
  };
}

/**
 * The file behind a copied placeholder, which Meta sends after the chunk. What
 * it was is written onto the imported message — "[image] the receipt" rather
 * than "[media]" — and the file itself is not fetched, as nothing about an
 * import is: it is months old and on the business's phone.
 *
 * False when no imported message holds the wamid: a placeholder this import
 * skipped because the number delivered it live, or a follow-up processed
 * before its chunk. The webhook row keeps it either way.
 */
export async function attachHistoryMedia(media: NormalisedHistoryMedia): Promise<boolean> {
  const updated = await db
    .update(messages)
    .set({
      bodyText: media.text,
      meta: sql`${messages.meta} || ${JSON.stringify({
        mediaPlaceholder: {
          mimeType: media.media.mimeType,
          filename: media.media.filename,
          isVoice: media.media.isVoice,
        },
      })}::jsonb`,
    })
    .where(
      and(
        eq(messages.channelMessageId, media.wamid),
        eq(messages.sourceSystem, 'import'),
        sql`${messages.meta} ->> 'history' = 'true'`,
      ),
    )
    .returning({ id: messages.id });
  return updated.length > 0;
}

export type ContactSyncResult = 'applied' | 'removed' | 'not_coexistence' | 'not_a_number';

/**
 * One entry of the phone's address book. `add` resolves the person to a
 * contact and names them from it, by the rules every channel profile follows
 * (`applyChannelProfile`): the identity takes the name, the contact only when
 * nobody has named it. `remove` changes nothing — the business deleting a
 * number from its phone says nothing about whether that person is a customer,
 * and the conversations on the contact still happened.
 */
export async function applyWhatsAppContactSync(
  sync: NormalisedContactSync,
  receivedAt: Date,
): Promise<ContactSyncResult> {
  const channel = await findCoexistenceChannel(sync.phoneNumberId);
  if (!channel) return 'not_coexistence';
  if (sync.action === 'remove') return 'removed';
  // An address-book entry is typed by hand; one with no digits in it is not a
  // number anybody can write from, and resolving it would throw on every retry.
  if (!normaliseIdentifier('whatsapp', sync.phone)) return 'not_a_number';

  const { contactId } = await resolveContact({
    channel: 'whatsapp',
    identifier: sync.phone,
    displayName: sync.name,
  });
  if (sync.name) {
    await applyChannelProfile({
      contactId,
      channel: 'whatsapp',
      identifier: sync.phone,
      name: sync.name,
      avatarPath: null,
      markFetched: false,
    });
  }
  await recordContactSync(channel.id, receivedAt);
  return 'applied';
}
