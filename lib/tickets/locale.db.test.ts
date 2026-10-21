import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { contacts, conversations, messages, ticketStatuses } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { requesterLocale } from './locale';

/**
 * The query half of `requesterLocale`, which `locale.test.ts` cannot reach:
 * which message decides the language an unattended sender writes in.
 */

withCleanDatabase();

async function ticket(
  channel: 'whatsapp' | 'facebook' | 'facebook_comment' | 'email',
): Promise<string> {
  const [contact] = await db.insert(contacts).values({ name: 'Amira' }).returning();
  const [open] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, 'Open'));
  const [row] = await db
    .insert(conversations)
    .values({ channel, statusId: open!.id, requesterContactId: contact!.id })
    .returning({ id: conversations.id });
  return row!.id;
}

describe('requesterLocale', () => {
  // `[reacted 🙏]` is seven Latin letters: read as the customer's words, it
  // would answer an Arabic customer in English for thanking us.
  it('reads the customer’s last words past a reaction', async () => {
    const id = await ticket('whatsapp');
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'فين شحنتي؟',
        meta: { whatsappType: 'text' },
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: '[reacted 🙏]',
        meta: { whatsappType: 'reaction' },
        createdAt: new Date('2026-10-01T10:05:00Z'),
      },
    ]);

    expect(await requesterLocale(id)).toBe('ar');
  });

  // A photo, a voice note or a document sent without a caption is stored as
  // our own label, and its Latin letters would answer an Arabic customer in
  // English for sending a photo of the damaged parcel.
  const labels = [
    { channel: 'whatsapp', bodyText: '[image]', meta: { whatsappType: 'image' } },
    { channel: 'whatsapp', bodyText: '[voice note]', meta: { whatsappType: 'audio' } },
    {
      channel: 'facebook',
      bodyText: '[2 attachments]',
      meta: { metaKind: 'direct_message', platform: 'facebook' },
    },
  ] as const;

  for (const label of labels) {
    it(`reads the customer’s last words past our ${label.bodyText} on ${label.channel}`, async () => {
      const id = await ticket(label.channel);
      await db.insert(messages).values([
        {
          conversationId: id,
          direction: 'inbound',
          bodyText: 'الشحنة وصلت مكسورة',
          createdAt: new Date('2026-10-01T10:00:00Z'),
        },
        {
          conversationId: id,
          direction: 'inbound',
          bodyText: label.bodyText,
          meta: label.meta,
          createdAt: new Date('2026-10-01T10:01:00Z'),
        },
      ]);

      expect(await requesterLocale(id)).toBe('ar');
    });
  }

  // An edit's label holds the corrected words inside fourteen Latin letters of
  // ours, which outvote a short Arabic correction. Over two lines, only
  // `WRAPPED_LABEL` recognises it as ours.
  it('reads past a WhatsApp edit to the message it corrects', async () => {
    const id = await ticket('whatsapp');
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'بكرة الساعة ٩',
        meta: { whatsappType: 'text' },
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: '[edited a message: بكرة\nالساعة 10]',
        meta: { whatsappType: 'edit' },
        createdAt: new Date('2026-10-01T10:02:00Z'),
      },
    ]);

    expect(await requesterLocale(id)).toBe('ar');
  });

  // The newest words decide, not the first: a customer who wrote Arabic, then
  // English, then sent a photo reads English. A query that found the oldest
  // surviving message would pass every test above.
  it('reads the newest of the customer’s words, not the first', async () => {
    const id = await ticket('whatsapp');
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'الشحنة وصلت مكسورة',
        meta: { whatsappType: 'text' },
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'the parcel arrived broken',
        meta: { whatsappType: 'text' },
        createdAt: new Date('2026-10-01T10:01:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: '[image]',
        meta: { whatsappType: 'image' },
        createdAt: new Date('2026-10-01T10:02:00Z'),
      },
    ]);

    expect(await requesterLocale(id)).toBe('en');
  });

  // A reaction is known by the type WhatsApp gave it, not by our spelling of
  // its text, which the label rule would also refuse: here only `notReaction`
  // stands between a thumbs-up and the customer's language.
  it('reads past a reaction whatever its text', async () => {
    const id = await ticket('whatsapp');
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'فين شحنتي؟',
        meta: { whatsappType: 'text' },
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'thumbs up',
        meta: { whatsappType: 'reaction' },
        createdAt: new Date('2026-10-01T10:05:00Z'),
      },
    ]);

    expect(await requesterLocale(id)).toBe('ar');
  });

  // Bare `btrim` strips only the space, so a body of line breaks was a message
  // to the query and nothing to read for `preferredLocale`.
  it('reads past a body that is nothing but whitespace', async () => {
    const id = await ticket('email');
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: 'الشحنة وصلت مكسورة',
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        bodyText: '\n\n',
        createdAt: new Date('2026-10-01T10:05:00Z'),
      },
    ]);

    expect(await requesterLocale(id)).toBe('ar');
  });

  /** The ticket's requester, and a second contact who writes on it too. */
  async function twoAuthors(id: string) {
    const [requester] = await db
      .select({ id: conversations.requesterContactId })
      .from(conversations)
      .where(eq(conversations.id, id));
    const [other] = await db.insert(contacts).values({ name: 'Bob' }).returning();
    return { requester: requester!.id, other: other!.id };
  }

  // On a comment thread a passer-by's reply is filed on the requester's
  // ticket. The acknowledgement is addressed to the requester, so the
  // passer-by's English does not choose its language when the requester's own
  // newest comment carried no words — nor once the passer-by's contact is
  // purged and the row has no author, since purging the requester would have
  // deleted the ticket.
  it('reads the requester’s words on a comment thread, not a passer-by’s', async () => {
    const id = await ticket('facebook_comment');
    const { requester, other } = await twoAuthors(id);
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        authorContactId: requester,
        bodyText: 'فين شحنتي؟',
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        authorContactId: other,
        bodyText: 'Same here, my parcel never came either',
        createdAt: new Date('2026-10-01T10:10:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        authorContactId: null,
        bodyText: 'Mine too, nobody answers the phone',
        createdAt: new Date('2026-10-01T10:15:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        authorContactId: requester,
        bodyText: '[empty comment]',
        createdAt: new Date('2026-10-01T10:20:00Z'),
      },
    ]);

    expect(await requesterLocale(id)).toBe('ar');
  });

  // Off a comment thread every customer row speaks, as it always has: a CC'd
  // colleague on an email writes in the conversation's language, and a
  // requester whose own mail carried no words would otherwise fall to
  // `contacts.locale`, which nothing writes.
  it('reads a second sender’s words on an email ticket', async () => {
    const id = await ticket('email');
    const { requester, other } = await twoAuthors(id);
    await db.insert(messages).values([
      {
        conversationId: id,
        direction: 'inbound',
        authorContactId: requester,
        bodyText: '[image]',
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        conversationId: id,
        direction: 'inbound',
        authorContactId: other,
        bodyText: 'الشحنة وصلت مكسورة',
        createdAt: new Date('2026-10-01T10:10:00Z'),
      },
    ]);

    expect(await requesterLocale(id)).toBe('ar');
  });

  // The rows that carry no `whatsappType` at all are the ones a careless
  // spelling of that rule would drop, and every ticket would read English.
  it('still reads a message with no WhatsApp type', async () => {
    const id = await ticket('email');
    await db.insert(messages).values({
      conversationId: id,
      direction: 'inbound',
      bodyText: 'الشحنة وصلت مكسورة',
    });

    expect(await requesterLocale(id)).toBe('ar');
  });
});
