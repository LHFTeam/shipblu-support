import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { carriesCustomerText } from './carries-customer-text';
import { WHITESPACE, hasCustomerText } from './customer-text';

/**
 * The two spellings of one rule — `carriesCustomerText()` for a query,
 * `hasCustomerText()` over a body already in hand — held to the same answer on
 * the same rows. `requesterLocale` picks the language an unattended reply goes
 * out in with one, and the ticket page picks what its knowledge panel and
 * canned picker open on with the other, so a body they disagree about is an
 * Arabic customer answered in one language and served in the other.
 *
 * They share their patterns, but not a regular-expression engine: what one
 * reads in JavaScript the other reads in Postgres. So the rows are the labels
 * as ingest writes them, the words a customer might plausibly send in brackets,
 * and the bodies where the two engines, or `trim()` and `btrim`, would part
 * company if the shared spelling stopped meaning the same thing in both.
 */

withCleanDatabase();

const LABELS = [
  '[image]',
  '[voice note]',
  '[document: فاتورة.pdf]',
  '[location: برج القاهرة, الزمالك (30.0459, 31.2243)]',
  '[shared 2 contact card(s)]',
  '[reacted 🙏]',
  '[media]',
  '[deleted a message]',
  '[unsupported message: Message type is not supported]',
  '[2 attachments]',
  '[story_mention]',
  '[]',
  '[[image]',
  '[\\]',
];

const EDITS = [
  '[edited a message]',
  '[edited a message: ]',
  '[edited a message: Tomorrow at 10]',
  '[edited a message: بكرة الساعة 10\nمش النهارده]',
  '[edited a message: see [the photo] again]',
  '[edited a message: one\r\ntwo\u2028three]',
  '[edited a message: [image]]',
];

const WORDS = [
  'فين شحنتي؟',
  'where is my parcel',
  '؟',
  'ok',
  'الشحنة [اتفتحت]',
  '[urgent] where is my COD',
  // A line break or a second bracket inside: not a label to either engine.
  '[one\ntwo]',
  '[one]two]',
  '[[image]]',
  '[image]\n[video]',
  // Not quite an edit: the label is ours, so its spelling is exact.
  '[Edited a message: one\ntwo]',
  '[edited a message:one\ntwo]',
];

/** Characters `trim()` leaves, and so must `btrim`: each is not whitespace to it. */
const NOT_WHITESPACE = ['\u0085', '\u180E', '\u200B', '\u200E', '\u200F', '\u061C', '\u2060'];

/** Each whitespace character alone, and round a label and round a word. */
const AROUND = [...WHITESPACE, ...NOT_WHITESPACE].flatMap((c) => [
  c,
  `${c}[image]${c}`,
  `${c}فين${c}`,
]);

const BODIES = [...LABELS, ...EDITS, ...WORDS, '', '   ', ...AROUND];

describe('carriesCustomerText and hasCustomerText', () => {
  it('keep and leave out exactly the same rows', async () => {
    const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
    const [open] = await db
      .select({ id: ticketStatuses.id })
      .from(ticketStatuses)
      .where(eq(ticketStatuses.name, 'Open'));
    const [conversation] = await db
      .insert(conversations)
      .values({ channel: 'whatsapp', statusId: open!.id, requesterContactId: contact!.id })
      .returning({ id: conversations.id });

    const rows = await db
      .insert(messages)
      .values(
        BODIES.map((bodyText) => ({
          conversationId: conversation!.id,
          direction: 'inbound' as const,
          bodyText,
        })),
      )
      .returning({ id: messages.id, bodyText: messages.bodyText });

    const kept = await db.select({ id: messages.id }).from(messages).where(carriesCustomerText());

    expect(new Set(kept.map((row) => row.id))).toEqual(
      new Set(rows.filter((row) => hasCustomerText(row.bodyText)).map((row) => row.id)),
    );
    // And the rule is the one meant: every label and edit, both blanks and
    // the twenty-five whitespace characters alone or round a label are refused;
    // everything else is somebody's words.
    const refused = rows.filter((row) => !hasCustomerText(row.bodyText));
    expect(refused).toHaveLength(LABELS.length + EDITS.length + 2 + 2 * WHITESPACE.length);
  });
});
