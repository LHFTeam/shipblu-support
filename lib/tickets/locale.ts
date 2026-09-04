import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, conversations, messages } from '@/db/schema';

/**
 * Which language we answer a customer in.
 *
 * One module because two things write to a customer in their own language with
 * nobody watching — the out-of-hours acknowledgement and the canned response an
 * automation rule sends — and a second implementation of this would show up in
 * production as two rules answering the same person in two languages.
 *
 * The console's canned-response picker is deliberately *not* wired through
 * here. It opens on `lib/kb/language.ts`'s `detectLocale`, the value the page
 * has already computed to search the knowledge base, so the panel and the
 * picker beside it agree with each other. The two detectors do not always
 * agree — `detectLocale` calls text Arabic from a fifth of its letters, this
 * one from a majority — and that is the right way round: the picker's answer is
 * a default an agent overrules with one click, and this one is a message that
 * has already been sent by the time anybody reads it.
 */

/**
 * Which language to answer in.
 *
 * `contacts.locale` is `not null default 'en'`, so 'en' means either "this
 * person reads English" or "nobody has ever said" — the distinction
 * `lib/contacts/merge.ts` already draws, and nothing in the product sets the
 * column, so today every one of the 6,000-odd contacts reads as the second.
 * Taking it at face value would answer an Arabic-first customer base in English
 * on every channel, which is the failure this project calls silent success: a
 * message goes out, a count goes up, and it is wrong in one direction only.
 *
 * So an explicitly Arabic contact is honoured, and everybody else is read from
 * the script of what they actually wrote. Counting letters rather than looking
 * for the first Arabic character is what keeps "SB123456 فين شحنتي" Arabic and
 * "my order to شبرا" English — an address or a name in the other alphabet is
 * not a change of language.
 */
export function preferredLocale(contactLocale: string, sample: string | null): 'ar' | 'en' {
  if (contactLocale === 'ar') return 'ar';
  if (!sample) return 'en';

  const arabic = sample.match(
    /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g,
  );
  const latin = sample.match(/[A-Za-z]/g);

  return (arabic?.length ?? 0) > (latin?.length ?? 0) ? 'ar' : 'en';
}

/**
 * The language to write to a ticket's requester in, read from the database.
 *
 * **Every unattended sender goes through here**, including the out-of-hours
 * acknowledgement, which used to read the language off the message it had
 * already loaded for its RFC 3834 check. That saved a query and cost the
 * invariant: that message is the last inbound row of *any* kind, and
 * `lib/forms/submit.ts` writes an inbound `system` row in English when an
 * attachment fails to store. An Arabic customer whose photo did not arrive was
 * acknowledged in English by the auto-responder and answered in Arabic by an
 * automation rule on the same ticket — two machines disagreeing about what one
 * person reads, which is the whole reason this module exists. One indexed query
 * on a path that sends at most one message per closed stretch is the right
 * price for that.
 *
 * Three things narrow which message decides it, and each of them is a way the
 * answer went wrong:
 *
 * - **`reply` only.** A bounce, an out-of-office or one of our own system
 *   notices is written by a mail server or by us, not by the person we are
 *   about to write to.
 * - **Non-empty text.** `body_text` is `not null default ''` and a WhatsApp or
 *   Instagram media message carries no text at all, so an Arabic customer whose
 *   last message is a photo of the damaged parcel would otherwise fall through
 *   to the contact locale and be answered in English. `btrim` rather than `<>
 *   ''` because `preferredLocale` treats whitespace as nothing to read, and a
 *   row it would reject should not have been the row that decided.
 * - **The most recent one that survives both.** Not the first message on the
 *   ticket: somebody who opened in English and has been writing Arabic for
 *   three messages reads Arabic.
 *
 * No usable message at all falls through to the contact's own locale, which is
 * the order `preferredLocale` applies anyway.
 */
export async function requesterLocale(conversationId: string): Promise<'ar' | 'en'> {
  const [contact, inbound] = await Promise.all([
    db
      .select({ locale: contacts.locale })
      .from(conversations)
      .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
      .where(eq(conversations.id, conversationId))
      .limit(1),
    db
      .select({ bodyText: messages.bodyText })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.direction, 'inbound'),
          eq(messages.kind, 'reply'),
          sql`btrim(${messages.bodyText}) <> ''`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1),
  ]);

  return preferredLocale(contact[0]?.locale ?? 'en', inbound[0]?.bodyText ?? null);
}
