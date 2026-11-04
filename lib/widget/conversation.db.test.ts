import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  attachments,
  contacts,
  conversationEvents,
  conversations,
  messages,
  ticketStatuses,
} from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';

/*
  Storage stood in for, so the files' path through `appendVisitorMessage` runs
  against Postgres without a bucket: an upload answers as Storage does, or
  fails for a file whose bytes say `FAIL`, and every key written or removed is
  kept. `during` runs inside an upload, for whatever a test needs to happen
  while one is on the wire.
*/
const storage = vi.hoisted(() => ({
  uploaded: [] as string[],
  removed: [] as string[],
  finishedAt: null as Date | null,
  during: null as (() => Promise<void>) | null,
}));
vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  uploadObject: async (path: string, content: Buffer) => {
    await storage.during?.();
    if (content.toString('latin1').includes('FAIL')) throw new Error('storage said no');
    storage.uploaded.push(path);
    storage.finishedAt = new Date();
    return { path, checksum: `sha-${content.length}`, sizeBytes: content.length };
  },
  removeObjects: async (paths: string[]) => {
    storage.removed.push(...paths);
    return { failed: [] };
  },
}));

/*
  A transaction that commits and then answers with an error, as one does when
  the connection is lost between COMMIT and its reply: the real one runs, then
  the throw. Armed for one transaction at a time.
*/
const lostCommit = vi.hoisted(() => ({ armed: false }));
vi.mock('@/db/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/db/client')>();
  const db = new Proxy(real.db, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (property === 'transaction' && lostCommit.armed) {
        lostCommit.armed = false;
        return async (...args: Parameters<typeof target.transaction>) => {
          await target.transaction(...args);
          throw new Error('connection lost after COMMIT');
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...real, db };
});

const { appendVisitorMessage, listMessages, widgetAttachmentPath, VisitorUploadFailed } =
  await import('./conversation');
const { fileLinkValid } = await import('./file-links');
type VisitorUpload = import('./conversation').VisitorUpload;

beforeEach(() => {
  storage.uploaded.length = 0;
  storage.removed.length = 0;
  storage.finishedAt = null;
  storage.during = null;
});

/**
 * What the widget's ingest path writes today, quirks included, so the shared
 * ingest steps of Stage 4.2 can be proven to change nothing.
 *
 * It takes the contact the visitor's token already resolved to, so each test
 * writes that contact itself. And it stamps its own clock rather than taking
 * one, so instants are asserted against the moments either side of the call.
 */

withCleanDatabase();

async function visitor(): Promise<string> {
  const [row] = await db.insert(contacts).values({ name: null }).returning({ id: contacts.id });
  if (!row) throw new Error('contact not inserted');
  return row.id;
}

async function conversation(id: string) {
  const [row] = await db
    .select({
      number: conversations.number,
      channel: conversations.channel,
      channelId: conversations.channelId,
      subject: conversations.subject,
      status: ticketStatuses.name,
      requesterContactId: conversations.requesterContactId,
      reopenCount: conversations.reopenCount,
      resolvedAt: conversations.resolvedAt,
      resolvedByAgentId: conversations.resolvedByAgentId,
      lastMessageAt: conversations.lastMessageAt,
      lastCustomerMessageAt: conversations.lastCustomerMessageAt,
    })
    .from(conversations)
    .innerJoin(ticketStatuses, eq(ticketStatuses.id, conversations.statusId))
    .where(eq(conversations.id, id));
  if (!row) throw new Error(`no conversation ${id}`);
  return row;
}

async function messagesOf(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

async function setStatus(conversationId: string, name: string, extra = {}) {
  const [status] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  if (!status) throw new Error(`no status ${name}`);
  await db
    .update(conversations)
    .set({ statusId: status.id, ...extra })
    .where(eq(conversations.id, conversationId));
}

/** Resolves a ticket the way an agent does: status, time and who. */
async function resolveAsAgent(conversationId: string): Promise<string> {
  const [agent] = await db
    .insert(agents)
    .values({ name: 'Omar', email: 'omar@shipblu.test' })
    .returning({ id: agents.id });
  if (!agent) throw new Error('no agent');
  await setStatus(conversationId, 'Resolved', {
    resolvedAt: new Date('2026-09-20T10:30:00Z'),
    resolvedByAgentId: agent.id,
  });
  return agent.id;
}

describe('appendVisitorMessage', () => {
  it('opens a web chat for a visitor’s first message', async () => {
    const contactId = await visitor();
    const before = Date.now();

    const result = await appendVisitorMessage(contactId, 'Hi, where is my parcel?', {
      pageUrl: 'https://shipblu.com/track',
      userAgent: 'Mozilla/5.0',
    });
    const after = Date.now();

    expect(result.createdConversation).toBe(true);

    const ticket = await conversation(result.conversationId);
    expect(ticket).toMatchObject({
      number: 1,
      channel: 'webchat',
      channelId: null,
      subject: 'Hi, where is my parcel?',
      status: 'Open',
      requesterContactId: contactId,
    });

    const [message] = await messagesOf(result.conversationId);
    expect(message).toMatchObject({
      id: result.messageId,
      direction: 'inbound',
      kind: 'reply',
      authorContactId: contactId,
      bodyText: 'Hi, where is my parcel?',
      // No HTML part, and no channel id: nothing to thread or dedupe on.
      bodyHtml: null,
      channelMessageId: null,
      deliveryStatus: 'delivered',
      meta: { pageUrl: 'https://shipblu.com/track', userAgent: 'Mozilla/5.0' },
    });

    // One clock for the whole write: the message and both conversation stamps.
    const at = message?.createdAt.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(message?.deliveredAt?.getTime()).toBe(at);
    expect(ticket.lastMessageAt?.getTime()).toBe(at);
    expect(ticket.lastCustomerMessageAt?.getTime()).toBe(at);

    const events = await db
      .select({ type: conversationEvents.type })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, result.conversationId));
    expect(events).toEqual([{ type: 'subcategorised' }]);
  });

  it('continues the visitor’s live chat', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');
    const second = await appendVisitorMessage(contactId, 'Anyone there?');

    expect(second).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    expect(await messagesOf(first.conversationId)).toHaveLength(2);
  });

  // Recorded, not endorsed: there is no message id to dedupe on, so a retried
  // POST from the widget is a second message.
  it('has no duplicate check: the same text twice is two messages', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');
    await appendVisitorMessage(contactId, 'Hello');

    expect(await messagesOf(first.conversationId)).toHaveLength(2);
  });

  it('reopens a resolved chat, with its own reason on the event', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');
    const resolver = await resolveAsAgent(first.conversationId);

    await appendVisitorMessage(contactId, 'One more thing');

    expect(await conversation(first.conversationId)).toMatchObject({
      status: 'Open',
      reopenCount: 1,
      resolvedAt: null,
      // Left for the event to read, as the email path leaves it.
      resolvedByAgentId: resolver,
    });
    const reopened = await db
      .select({ actorLabel: conversationEvents.actorLabel, data: conversationEvents.data })
      .from(conversationEvents)
      .where(eq(conversationEvents.type, 'reopened'));
    // `visitor_replied`, where every other path says `customer_replied`.
    expect(reopened).toEqual([
      { actorLabel: 'webchat', data: { reason: 'visitor_replied', resolvedBy: resolver } },
    ]);
  });

  it('starts a new chat after the last one was closed', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');
    await setStatus(first.conversationId, 'Closed');

    const second = await appendVisitorMessage(contactId, 'Back again');

    expect(second.createdConversation).toBe(true);
    expect(second.conversationId).not.toBe(first.conversationId);
  });

  it('names an empty first message "Web chat"', async () => {
    const contactId = await visitor();
    const result = await appendVisitorMessage(contactId, '');

    expect((await conversation(result.conversationId)).subject).toBe('Web chat');
  });
});

/** A file as the route hands it over: judged, typed by its bytes, its name cleaned. */
function upload(
  filename: string,
  kind: VisitorUpload['kind'],
  contentType: string,
  extension: string,
  content = 'bytes',
): VisitorUpload {
  return { filename, kind, contentType, extension, bytes: Buffer.from(content) };
}

async function filesOf(messageId: string) {
  return db
    .select({
      filename: attachments.filename,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
      storagePath: attachments.storagePath,
    })
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .orderBy(asc(attachments.storagePath));
}

describe('appendVisitorMessage with files', () => {
  it('stores a photo with its message, under keys made of ids, with the stand-in as its words', async () => {
    const contactId = await visitor();

    const result = await appendVisitorMessage(contactId, '', {}, [
      upload('صورة الشحنة.jpg', 'image', 'image/jpeg', 'jpg'),
    ]);

    const ticket = await conversation(result.conversationId);
    expect(ticket.subject).toBe('[image]');

    const [message] = await messagesOf(result.conversationId);
    expect(message).toMatchObject({
      id: result.messageId,
      bodyText: '[image]',
      meta: {
        pageUrl: null,
        userAgent: null,
        webchatFiles: [{ kind: 'image', filename: 'صورة الشحنة.jpg' }],
      },
    });

    const path = `conversations/${result.conversationId}/${result.messageId}-0.jpg`;
    expect(storage.uploaded).toEqual([path]);
    expect(await filesOf(result.messageId)).toEqual([
      { filename: 'صورة الشحنة.jpg', contentType: 'image/jpeg', sizeBytes: 5, storagePath: path },
    ]);
  });

  it('keeps the visitor’s words over the stand-in, and the files in the order chosen', async () => {
    const contactId = await visitor();

    const result = await appendVisitorMessage(contactId, 'The box arrived like this', {}, [
      upload('one.jpg', 'image', 'image/jpeg', 'jpg'),
      upload('invoice.pdf', 'document', 'application/pdf', 'pdf'),
      upload('memo.m4a', 'audio', 'audio/mp4', 'm4a'),
    ]);

    const [message] = await messagesOf(result.conversationId);
    expect(message?.bodyText).toBe('The box arrived like this');
    expect((await filesOf(result.messageId)).map((file) => file.filename)).toEqual([
      'one.jpg',
      'invoice.pdf',
      'memo.m4a',
    ]);
  });

  it('stores nothing when a file cannot be stored, and removes every key it tried', async () => {
    const contactId = await visitor();

    await expect(
      appendVisitorMessage(contactId, 'Here', {}, [
        upload('fine.jpg', 'image', 'image/jpeg', 'jpg'),
        upload('fail.jpg', 'image', 'image/jpeg', 'jpg', 'FAIL'),
      ]),
    ).rejects.toBeInstanceOf(VisitorUploadFailed);

    expect(await db.select().from(conversations)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
    expect(await db.select().from(attachments)).toEqual([]);
    // The failed one too: an upload that answered with an error may still
    // have been written.
    expect(storage.uploaded).toHaveLength(1);
    expect(storage.removed).toHaveLength(2);
    expect(storage.removed).toEqual(expect.arrayContaining(storage.uploaded));
  });

  it('removes the stored files when the transaction refuses the message', async () => {
    // A requester that does not exist: the files store, the insert fails on
    // its foreign key, and nothing may be left referencing nothing.
    await expect(
      appendVisitorMessage(randomUUID(), '', {}, [upload('a.jpg', 'image', 'image/jpeg', 'jpg')]),
    ).rejects.not.toBeInstanceOf(VisitorUploadFailed);

    expect(await db.select().from(conversations)).toEqual([]);
    expect(await db.select().from(attachments)).toEqual([]);
    expect(storage.uploaded).toHaveLength(1);
    expect(storage.removed).toEqual(storage.uploaded);
  });

  it('keeps the files when the commit happened but its answer was lost', async () => {
    const contactId = await visitor();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    lostCommit.armed = true;

    try {
      const result = await appendVisitorMessage(contactId, '', {}, [
        upload('a.jpg', 'image', 'image/jpeg', 'jpg'),
      ]);

      // The message's own transaction was the one that answered with the error.
      expect(warn).toHaveBeenCalledWith(
        `[widget_files] a transaction answered with an error but its message was stored, kept its files message_id=${result.messageId}`,
      );
      expect(storage.removed).toEqual([]);
      expect(await filesOf(result.messageId)).toHaveLength(1);
    } finally {
      lostCommit.armed = false;
      warn.mockRestore();
    }
  });

  it('dates the message when its files are stored, not when the upload began', async () => {
    const contactId = await visitor();
    storage.during = () => new Promise((resolve) => setTimeout(resolve, 50));

    const result = await appendVisitorMessage(contactId, '', {}, [
      upload('door.mov', 'video', 'video/quicktime', 'mov'),
    ]);

    const [message] = await messagesOf(result.conversationId);
    expect(message!.createdAt.getTime()).toBeGreaterThanOrEqual(storage.finishedAt!.getTime());
    const ticket = await conversation(result.conversationId);
    expect(ticket.lastCustomerMessageAt?.getTime()).toBe(message!.createdAt.getTime());
  });

  it('opens a new chat when the live one was closed while the files uploaded', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');
    storage.during = () => setStatus(first.conversationId, 'Closed');

    const second = await appendVisitorMessage(contactId, '', {}, [
      upload('box.jpg', 'image', 'image/jpeg', 'jpg'),
    ]);

    expect(second.createdConversation).toBe(true);
    expect(second.conversationId).not.toBe(first.conversationId);
    // Stored under the ticket that was live, and found through its row.
    expect((await filesOf(second.messageId))[0]?.storagePath).toContain(first.conversationId);
  });

  it('records the files in the order attached, for the console as for the widget', async () => {
    const contactId = await visitor();
    const result = await appendVisitorMessage(contactId, '', {}, [
      upload('first.jpg', 'image', 'image/jpeg', 'jpg'),
      upload('second.jpg', 'image', 'image/jpeg', 'jpg'),
      upload('third.jpg', 'image', 'image/jpeg', 'jpg'),
    ]);

    // The console's own order: `created_at`, then a random id.
    const rows = await db
      .select({ filename: attachments.filename })
      .from(attachments)
      .where(eq(attachments.messageId, result.messageId))
      .orderBy(asc(attachments.createdAt), asc(attachments.id));
    expect(rows.map((row) => row.filename)).toEqual(['first.jpg', 'second.jpg', 'third.jpg']);
  });

  it('adds files to the live chat rather than opening another', async () => {
    const contactId = await visitor();
    const first = await appendVisitorMessage(contactId, 'Hello');

    const second = await appendVisitorMessage(contactId, '', {}, [
      upload('door.mov', 'video', 'video/quicktime', 'mov'),
    ]);

    expect(second).toMatchObject({
      conversationId: first.conversationId,
      createdConversation: false,
    });
    expect(storage.uploaded).toEqual([
      `conversations/${first.conversationId}/${second.messageId}-0.mov`,
    ]);
  });
});

describe('listMessages', () => {
  it('draws a stand-in as its files alone, and a caption with them', async () => {
    const contactId = await visitor();
    const photo = await appendVisitorMessage(contactId, '', {}, [
      upload('box.jpg', 'image', 'image/jpeg', 'jpg'),
      upload('label.pdf', 'document', 'application/pdf', 'pdf', 'pdf-bytes'),
    ]);
    await appendVisitorMessage(contactId, 'See above', {}, [
      upload('memo.m4a', 'audio', 'audio/mp4', 'm4a'),
    ]);
    await appendVisitorMessage(contactId, '[image]');

    const transcript = await listMessages(photo.conversationId);

    // Each file carries a link signed for it alone, and no token.
    const now = new Date();
    for (const file of transcript.flatMap((m) => m.attachments ?? [])) {
      const url = new URL(file.url!, 'https://support.example');
      expect(url.pathname).toBe(`/api/widget/attachments/${file.id}`);
      expect(
        fileLinkValid(
          file.id,
          url.searchParams.get('expires'),
          url.searchParams.get('signature'),
          now,
        ),
      ).toBe(true);
    }

    expect(transcript.map(({ body, attachments: files }) => ({ body, files }))).toEqual([
      {
        body: '',
        files: [
          {
            id: expect.any(String),
            filename: 'box.jpg',
            contentType: 'image/jpeg',
            sizeBytes: 5,
            url: expect.any(String),
          },
          {
            id: expect.any(String),
            filename: 'label.pdf',
            contentType: 'application/pdf',
            sizeBytes: 9,
            url: expect.any(String),
          },
        ],
      },
      {
        body: 'See above',
        files: [
          {
            id: expect.any(String),
            filename: 'memo.m4a',
            contentType: 'audio/mp4',
            sizeBytes: 5,
            url: expect.any(String),
          },
        ],
      },
      // Typed by the visitor, with no file: their words, kept.
      { body: '[image]', files: [] },
    ]);
  });

  it('leaves out a file on a private note, with the note', async () => {
    const contactId = await visitor();
    const chat = await appendVisitorMessage(contactId, 'Hello');
    const [note] = await db
      .insert(messages)
      .values({
        conversationId: chat.conversationId,
        direction: 'outbound',
        kind: 'note',
        bodyText: 'internal',
      })
      .returning({ id: messages.id });
    await db.insert(attachments).values({
      messageId: note!.id,
      storagePath: 'conversations/x/note.pdf',
      filename: 'note.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
    });

    expect((await listMessages(chat.conversationId)).flatMap((m) => m.attachments ?? [])).toEqual(
      [],
    );
  });
});

describe('widgetAttachmentPath', () => {
  async function visitorWithFile() {
    const contactId = await visitor();
    const chat = await appendVisitorMessage(contactId, '', {}, [
      upload('box.jpg', 'image', 'image/jpeg', 'jpg'),
    ]);
    const [file] = await db
      .select({ id: attachments.id, path: attachments.storagePath })
      .from(attachments)
      .where(eq(attachments.messageId, chat.messageId));
    return { contactId, chat, file: file! };
  }

  it('opens a file on a web chat reply', async () => {
    const { file } = await visitorWithFile();
    expect(await widgetAttachmentPath(file.id)).toBe(file.path);
  });

  it('opens nothing on a deleted chat, though its links have not expired', async () => {
    const { chat, file } = await visitorWithFile();
    await db
      .update(conversations)
      .set({ deletedAt: new Date() })
      .where(eq(conversations.id, chat.conversationId));
    expect(await widgetAttachmentPath(file.id)).toBeNull();
  });

  it('opens nothing on a note, though it is on the visitor’s own chat', async () => {
    const { chat } = await visitorWithFile();
    const [note] = await db
      .insert(messages)
      .values({
        conversationId: chat.conversationId,
        direction: 'outbound',
        kind: 'note',
        bodyText: 'internal',
      })
      .returning({ id: messages.id });
    const [file] = await db
      .insert(attachments)
      .values({
        messageId: note!.id,
        storagePath: 'conversations/x/note.pdf',
        filename: 'note.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      })
      .returning({ id: attachments.id });
    expect(await widgetAttachmentPath(file!.id)).toBeNull();
  });

  it('opens nothing on a ticket that is not a web chat', async () => {
    const { chat, file } = await visitorWithFile();
    await db
      .update(conversations)
      .set({ channel: 'email' })
      .where(eq(conversations.id, chat.conversationId));
    expect(await widgetAttachmentPath(file.id)).toBeNull();
  });
});
