import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, conversations, messages } from '@/db/schema';
import { carriesCustomerText } from './carries-customer-text';
import { notReaction } from './not-reaction';

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
 * column, so today every contact reads as the second.
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
 * Four things narrow which message decides it, and each of them is a way the
 * answer went wrong:
 *
 * - **`reply` only.** One of our own system notices, like that attachment line,
 *   is written by us, not by the person we are about to write to. A mail
 *   server's bounce or out-of-office is not kept out by this: it arrives as
 *   mail and is stored as a reply, flagged on `meta` (`isBounce`,
 *   `isAutoReply`), and nothing here reads those flags yet.
 * - **Words the customer wrote.** A media message is not blank: a photo, a
 *   voice note or a document sent without a caption is stored with our own
 *   English label — `[image]`, `[voice note]`, `[2 attachments]` — so the
 *   console draws a bubble, and read as the customer's words its Latin letters
 *   would answer an Arabic customer in English for sending a photo of the
 *   damaged parcel. `carriesCustomerText()` passes over a label, and over a
 *   body that is blank once trimmed, in which `preferredLocale` would find
 *   nothing to read. It passes over a WhatsApp edit too, although that label
 *   holds the customer's corrected words: they sit inside fourteen Latin
 *   letters of ours, which outvote a short Arabic correction, and a correction
 *   is in the language of the message it corrects, which the same person
 *   already sent — on this ticket, unless the edit came after it closed and
 *   opened one of its own, where nothing is left to read. A label is passed
 *   over even when what it names is Arabic — a document's file name, the
 *   address of a dropped pin — because neither was written to us. A ticket
 *   holding nothing else falls to the contact's locale, which is 'en' for
 *   every contact until something writes the column.
 * - **Not a WhatsApp reaction.** Its text is our own `[reacted 🙏]`, seven
 *   Latin letters and an emoji, so an Arabic customer who answered the agent's
 *   reply with a thumbs-up would be read as English from then on. The label
 *   rule refuses that text as well; `notReaction()` stays because it reads the
 *   type WhatsApp gave the row rather than our spelling of it.
 * - **The most recent one that survives those.** Not the first message on the
 *   ticket: somebody who opened in English and has been writing Arabic for
 *   three messages reads Arabic.
 *
 * No usable message at all falls through to the contact's own locale, which is
 * the order `preferredLocale` applies anyway.
 */
export async function requesterLocale(
  conversationId: string,
  /** The requester's `contacts.locale` when the caller already read it, so it is not read twice. */
  contactLocale?: string | null,
): Promise<'ar' | 'en'> {
  const [contact, words] = await Promise.all([
    contactLocale === undefined
      ? db
          .select({ locale: contacts.locale })
          .from(conversations)
          .leftJoin(contacts, eq(contacts.id, conversations.requesterContactId))
          .where(eq(conversations.id, conversationId))
          .limit(1)
      : Promise.resolve([{ locale: contactLocale }]),
    newestCustomerWords(conversationId),
  ]);

  return preferredLocale(contact[0]?.locale ?? 'en', words);
}

/**
 * The newest thing the customer wrote on a ticket, by the rules above: the
 * query's half of `lastCustomerWords`, which a ticket page runs over the
 * timeline it holds. Also how a canned suggestion records the language the
 * page showed, which is why it reads the whole ticket rather than the ten
 * replies the suggestion is asked about: a run of photos would push the words
 * the page read out of that window. Ties are broken by id, as the timeline
 * breaks them.
 */
export async function newestCustomerWords(conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ bodyText: messages.bodyText })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.direction, 'inbound'),
        eq(messages.kind, 'reply'),
        carriesCustomerText(),
        notReaction(),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row?.bodyText ?? null;
}
