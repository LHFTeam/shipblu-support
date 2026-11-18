import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The myBlu app's files against Postgres (`plans/myblu-ticket-api.md`,
 * stage 7): a send carrying them, through the routes as the SDK calls them —
 * the multipart body written out first, with its exact `Content-Length` — and
 * the link that fetches one back.
 *
 * Storage is stood in for, as the widget's database test stands in for it: an
 * upload answers as Storage does, or fails for a file whose bytes say `FAIL`,
 * and every key written, removed or signed is kept. And a transaction can be
 * armed to commit and then answer with an error, as one does when the
 * connection is lost between COMMIT and its reply.
 */

const storage = vi.hoisted(() => ({
  uploaded: [] as string[],
  removed: [] as string[],
  signed: [] as { path: string; expiresInSeconds: number }[],
  /** Run once during the next upload: a write landing while the file is on its way. */
  duringUpload: null as (() => Promise<void>) | null,
}));

vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  uploadObject: async (path: string, content: Buffer) => {
    if (content.toString('latin1').includes('FAIL')) throw new Error('storage said no');
    const during = storage.duringUpload;
    storage.duringUpload = null;
    if (during) await during();
    storage.uploaded.push(path);
    return { path, checksum: `sha-${content.length}`, sizeBytes: content.length };
  },
  removeObjects: async (paths: string[]) => {
    storage.removed.push(...paths);
    return { failed: [] };
  },
  signedUrl: async (path: string, expiresInSeconds = 300) => {
    storage.signed.push({ path, expiresInSeconds });
    return `https://storage.example.test/object/sign/${path}?token=t`;
  },
}));

const lostCommit = vi.hoisted(() => ({
  armed: false,
  /** The transaction after the lost one fails before it starts: the pool still down. */
  thenFails: false,
}));
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
      if (property === 'transaction' && lostCommit.thenFails) {
        lostCommit.thenFails = false;
        return () => Promise.reject(new Error('connection lost again'));
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...real, db };
});

const { db } = await import('@/db/client');
const {
  agents,
  apiTickets,
  attachments,
  channels,
  contacts,
  conversations,
  messages,
  ticketStatuses,
} = await import('@/db/schema');
const { resetEnvCache } = await import('@/lib/env');
const { withCleanDatabase } = await import('@/lib/testing/db');
const { UPLOAD_BYTES_LIMIT, uploadFits } = await import('@/lib/api/limits');
const { lookupSession } = await import('@/lib/api/sessions');
const { AttachmentLink, ErrorBody, SendResult, Session } = await import('@/lib/api/schemas');
const { POST: postSession } = await import('./sessions/route');
const { POST: postTicket } = await import('./tickets/route');
const { GET: getMessages, POST: postMessage } = await import('./tickets/[id]/messages/route');
const { GET: getAttachment } = await import('./attachments/[id]/route');

withCleanDatabase();

const TOKEN = 'db-test-myblu-api-token-0123456789-abcdef';
const CLIENT = 'sdk-ts/0.4.0 app/5.4.1 ios/18.1';

/** A JPEG's and a PDF's first bytes, padded to a plausible header. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(64).fill(0)]);
const PDF = new TextEncoder().encode(`%PDF-1.7\n${' '.repeat(64)}`);
/** A JPEG Storage refuses (`FAIL` in its bytes). */
const FAILING = new Uint8Array([...JPEG, ...new TextEncoder().encode('FAIL')]);

let seq = 0;
let user = '';
let next = 0;
const address = () => `198.51.100.${(next += 1) % 250}-${next}`;

beforeEach(async () => {
  seq += 1;
  user = `files_${seq}`;
  storage.uploaded.length = 0;
  storage.removed.length = 0;
  storage.signed.length = 0;
  storage.duringUpload = null;
  lostCommit.armed = false;
  lostCommit.thenFails = false;
  vi.stubEnv('MYBLU_API_TOKEN', TOKEN);
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await db.insert(channels).values({ type: 'api', name: 'myBlu app', config: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
});

// --- Fixtures ---------------------------------------------------------------

async function minted(externalUserId = user): Promise<string> {
  const response = await postSession(
    new Request('https://support.shipblu.com/api/v1/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'x-forwarded-for': address(),
      },
      body: JSON.stringify({
        externalUserId,
        phone: `+2011${String((seq * 7 + next) % 100_000_000).padStart(8, '0')}`,
        client: { platform: 'ios', appVersion: '5.4.1' },
      }),
    }),
  );
  expect(response.status).toBe(201);
  return Session.parse(await response.json()).token;
}

type Part = [string, string | File];

/** A send as the SDK makes one: multipart, written out first, with its exact length. */
async function multipartRequest(
  path: string,
  token: string,
  parts: Part[],
  key: string = randomUUID(),
) {
  const form = new FormData();
  for (const [name, value] of parts) form.append(name, value);
  const encoded = new Response(form);
  const bytes = await encoded.arrayBuffer();
  return new Request(`https://support.shipblu.com/api/v1${path}`, {
    method: 'POST',
    body: bytes,
    headers: {
      Authorization: `Bearer ${token}`,
      'ShipBlu-Client': CLIENT,
      'x-forwarded-for': address(),
      'Idempotency-Key': key,
      'Content-Type': encoded.headers.get('content-type') ?? '',
      'Content-Length': String(bytes.byteLength),
    },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const photo = (name = 'IMG_0412.jpg', bytes = JPEG) =>
  new File([bytes], name, { type: 'image/jpeg' });

function create(token: string, parts: Part[], key?: string) {
  return multipartRequest('/tickets', token, [['locale', 'en'], ...parts], key).then(postTicket);
}

function send(token: string, ticketId: string, parts: Part[], key?: string) {
  return multipartRequest(
    `/tickets/${ticketId}/messages`,
    token,
    [['locale', 'en'], ...parts],
    key,
  ).then((request) => postMessage(request, params(ticketId)));
}

async function sent(response: Response, status = 201) {
  expect(response.status).toBe(status);
  return SendResult.parse(await response.json());
}

async function refusal(response: Response) {
  return { status: response.status, ...ErrorBody.parse(await response.json()).error };
}

function link(token: string, attachmentId: string) {
  return getAttachment(
    new Request(`https://support.shipblu.com/api/v1/attachments/${attachmentId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'ShipBlu-Client': CLIENT,
        'x-forwarded-for': address(),
      },
    }),
    params(attachmentId),
  );
}

async function statusId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: ticketStatuses.id })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.name, name));
  return row!.id;
}

async function storedFiles(messageId: string) {
  return db
    .select({
      storagePath: attachments.storagePath,
      filename: attachments.filename,
      contentType: attachments.contentType,
    })
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .orderBy(asc(attachments.createdAt));
}

// --- Sending files ----------------------------------------------------------

describe('a send with files', () => {
  it('opens a ticket with a photo and no words: the file stored by its bytes, the text "" and no subject', async () => {
    const token = await minted();

    const result = await sent(
      await create(token, [
        ['text', ''],
        ['files', photo()],
      ]),
    );

    expect(result.ticket.subject).toBeNull();
    expect(result.message).toMatchObject({ from: 'customer', text: '' });
    expect(result.message.attachments).toEqual([
      {
        id: expect.any(String),
        filename: 'IMG_0412.jpg',
        contentType: 'image/jpeg',
        sizeBytes: JPEG.length,
      },
    ]);

    // Stored under the ticket and the message, by ids, with the stand-in the
    // console's card reads and the list its thread rebuilds it from.
    const [row] = await db
      .select({ bodyText: messages.bodyText, meta: messages.meta })
      .from(messages)
      .where(eq(messages.id, result.message.id));
    expect(row).toMatchObject({
      bodyText: '[image]',
      meta: { webchatFiles: [{ kind: 'image', filename: 'IMG_0412.jpg' }], locale: 'en' },
    });
    const files = await storedFiles(result.message.id);
    expect(files).toEqual([
      {
        storagePath: `conversations/${result.ticket.id}/${result.message.id}-0.jpg`,
        filename: 'IMG_0412.jpg',
        contentType: 'image/jpeg',
      },
    ]);
    expect(storage.uploaded).toEqual([files[0]!.storagePath]);
    expect(storage.removed).toEqual([]);
  });

  it('sends words and files on a ticket, in the order sent, each typed by its bytes', async () => {
    const token = await minted();
    const ticket = (await sent(await create(token, [['text', 'Where is it?']]))).ticket;

    const result = await sent(
      await send(token, ticket.id, [
        ['text', 'The box and the waybill'],
        ['files', photo('box.jpg')],
        // Labelled as a photo, stored as what its bytes are.
        ['files', new File([PDF], 'awb.jpg', { type: 'image/jpeg' })],
      ]),
    );

    expect(result.message.text).toBe('The box and the waybill');
    expect(
      result.message.attachments.map(({ filename, contentType }) => ({ filename, contentType })),
    ).toEqual([
      { filename: 'box.jpg', contentType: 'image/jpeg' },
      { filename: 'awb.jpg', contentType: 'application/pdf' },
    ]);
    // The thread reads them back as the send answered them.
    const page = await getMessages(
      new Request(`https://support.shipblu.com/api/v1/tickets/${ticket.id}/messages`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'ShipBlu-Client': CLIENT,
          'x-forwarded-for': address(),
        },
      }),
      params(ticket.id),
    );
    const body = (await page.json()) as { messages: { id: string; attachments: unknown[] }[] };
    expect(body.messages.find((m) => m.id === result.message.id)?.attachments).toEqual(
      result.message.attachments,
    );
  });

  it('stores nothing when a file cannot be stored, and removes every key it tried', async () => {
    const token = await minted();

    const failed = await refusal(
      await create(token, [
        ['text', 'Two photos'],
        ['files', photo('ok.jpg')],
        ['files', photo('bad.jpg', FAILING)],
      ]),
    );

    expect(failed).toMatchObject({ status: 502, code: 'upload_failed' });
    expect(await db.select({ id: conversations.id }).from(conversations)).toEqual([]);
    expect(await db.select({ id: attachments.id }).from(attachments)).toEqual([]);
    expect(storage.removed).toHaveLength(2);
    expect(storage.removed).toEqual(expect.arrayContaining(storage.uploaded));
  });

  /** Ten open tickets of the caller's, written straight in rather than through the route, whose own bucket allows ten an hour. */
  async function tenOpen(token: string) {
    const session = await lookupSession(token, new Date());
    if (session.kind !== 'live') throw new Error('expected a live session');
    const open = await statusId('Open');
    for (let i = 0; i < 10; i += 1) {
      const [row] = await db
        .insert(conversations)
        .values({ channel: 'api', statusId: open, requesterContactId: session.caller.contactId })
        .returning({ id: conversations.id });
      await db
        .insert(apiTickets)
        .values({ conversationId: row!.id, identityId: session.caller.identityId });
    }
  }

  // An outbox resends a refused create on every foreground: asked only under
  // the lock, each resend uploaded its video and removed it again.
  it('uploads nothing for a create at the open cap', async () => {
    const token = await minted();
    await tenOpen(token);

    expect(await refusal(await create(token, [['files', photo()]]))).toMatchObject({
      status: 409,
      code: 'too_many_open',
    });
    expect(storage.uploaded).toEqual([]);
  });

  it('removes the files of a send the lock refuses, and keeps nothing behind', async () => {
    const token = await minted();
    // The cap is reached while the file is on its way, so the pool's count
    // passes and the count under the account's lock refuses.
    storage.duringUpload = () => tenOpen(token);

    expect(await refusal(await create(token, [['files', photo()]]))).toMatchObject({
      status: 409,
      code: 'too_many_open',
    });
    expect(storage.uploaded).toHaveLength(1);
    expect(storage.removed).toEqual(storage.uploaded);
    expect(await db.select({ id: attachments.id }).from(attachments)).toEqual([]);
  });

  it('uploads nothing for a closed ticket or one that is not the user’s', async () => {
    const token = await minted();
    const other = await minted(`${user}_other`);
    const ticket = (await sent(await create(token, [['text', 'Hello']]))).ticket;

    expect(await refusal(await send(other, ticket.id, [['files', photo()]]))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    await db
      .update(conversations)
      .set({ statusId: await statusId('Closed') })
      .where(eq(conversations.id, ticket.id));
    expect(await refusal(await send(token, ticket.id, [['files', photo()]]))).toMatchObject({
      status: 409,
      code: 'ticket_closed',
    });
    expect(storage.uploaded).toEqual([]);
  });

  // The widget's send carries on when its message turns out stored; answered
  // 500, this one ran none of the work after the commit, and the SDK's retry,
  // a replay, ran none of it either.
  it('carries on after a reply whose COMMIT landed but whose answer was lost, its files kept and its budget spent', async () => {
    const token = await minted();
    const session = await lookupSession(token, new Date());
    if (session.kind !== 'live') throw new Error('expected a live session');
    const ticket = (await sent(await create(token, [['text', 'Hello']]))).ticket;
    const key = randomUUID();

    lostCommit.armed = true;
    const answered = await sent(await send(token, ticket.id, [['files', photo()]], key));
    expect(answered.message.attachments).toHaveLength(1);
    expect(storage.removed).toEqual([]);
    // The work after the commit ran: the budget is spent.
    expect(
      uploadFits(session.caller.identityId, UPLOAD_BYTES_LIMIT - JPEG.length + 1).allowed,
    ).toBe(false);

    // The SDK's retry under the same key: what the first stored, its file
    // included, and nothing uploaded a second time.
    const replayed = await sent(await send(token, ticket.id, [['files', photo()]], key), 200);
    expect(replayed.message.id).toBe(answered.message.id);
    expect(storage.uploaded).toHaveLength(1);
    expect(storage.removed).toEqual([]);
  });

  // The pool has just lost one answer, so the re-read of the requester can
  // fail too: thrown, its error took the place of the first, the request
  // answered 500, and the budget the stored file owed went unspent.
  it('carries on with the session’s requester when the re-read after a lost answer fails too', async () => {
    const token = await minted();
    const session = await lookupSession(token, new Date());
    if (session.kind !== 'live') throw new Error('expected a live session');
    const ticket = (await sent(await create(token, [['text', 'Hello']]))).ticket;

    lostCommit.armed = true;
    lostCommit.thenFails = true;
    const answered = await sent(await send(token, ticket.id, [['files', photo()]]));

    expect(answered.message.attachments).toHaveLength(1);
    expect(lostCommit.thenFails).toBe(false);
    expect(
      uploadFits(session.caller.identityId, UPLOAD_BYTES_LIMIT - JPEG.length + 1).allowed,
    ).toBe(false);
  });

  it('carries on after a create whose COMMIT landed but whose answer was lost, files or none', async () => {
    const token = await minted();

    lostCommit.armed = true;
    const withFile = await sent(await create(token, [['files', photo()]]));
    expect(withFile.message.attachments).toHaveLength(1);
    expect(storage.removed).toEqual([]);

    lostCommit.armed = true;
    const words = await sent(await create(token, [['text', 'Where is my parcel?']]));
    expect(words.message.text).toBe('Where is my parcel?');
    // One ticket each, answered rather than left for a replay to find.
    const opened = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.channel, 'api'));
    expect(opened.map((row) => row.id).sort()).toEqual(
      [withFile.ticket.id, words.ticket.id].sort(),
    );
  });

  // The pre-check read the ticket by the identity alone, so a ticket an agent
  // had moved to another contact answered its status — a closed one `409`, an
  // open one a 25 MB upload — where the locked read answers `404`.
  it('uploads nothing to a ticket whose requester was moved, and answers 404 as the locked read does', async () => {
    const token = await minted();
    const ticket = (await sent(await create(token, [['text', 'Hello']]))).ticket;
    const [other] = await db
      .insert(contacts)
      .values({ name: 'Somebody else' })
      .returning({ id: contacts.id });
    await db
      .update(conversations)
      .set({ requesterContactId: other!.id })
      .where(eq(conversations.id, ticket.id));

    expect(await refusal(await send(token, ticket.id, [['files', photo()]]))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    await db
      .update(conversations)
      .set({ statusId: await statusId('Closed') })
      .where(eq(conversations.id, ticket.id));
    expect(await refusal(await send(token, ticket.id, [['files', photo()]]))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(storage.uploaded).toEqual([]);
  });

  // The SDK's outbox resends a send it never heard back from, a 25 MB video
  // included; the key is answered before the body is read, so a body nothing
  // could read is still that send's replay.
  it('answers a retry under a spent key before it reads the body', async () => {
    const token = await minted();
    const createKey = randomUUID();
    const opened = await sent(await create(token, [['files', photo()]], createKey));
    const sendKey = randomUUID();
    const reply = await sent(await send(token, opened.ticket.id, [['files', photo()]], sendKey));

    const unreadable = (path: string, key: string) =>
      new Request(`https://support.shipblu.com/api/v1${path}`, {
        method: 'POST',
        body: '{',
        headers: {
          Authorization: `Bearer ${token}`,
          'ShipBlu-Client': CLIENT,
          'x-forwarded-for': address(),
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
      });
    const created = await sent(await postTicket(unreadable('/tickets', createKey)), 200);
    expect(created.message.id).toBe(opened.message.id);
    const replied = await sent(
      await postMessage(
        unreadable(`/tickets/${opened.ticket.id}/messages`, sendKey),
        params(opened.ticket.id),
      ),
      200,
    );
    expect(replied.message.id).toBe(reply.message.id);
    expect(storage.uploaded).toHaveLength(2);
  });

  // The form encoding turns every line break into CRLF, so words sent with a
  // photo were longer than the same words sent alone, and stored with CRs.
  it('keeps the line breaks a user typed in the words beside a file', async () => {
    const token = await minted();
    const opened = await sent(
      await create(token, [
        ['text', 'Line one\nLine two'],
        ['files', photo()],
      ]),
    );

    expect(opened.message.text).toBe('Line one\nLine two');
    const [row] = await db
      .select({ bodyText: messages.bodyText })
      .from(messages)
      .where(eq(messages.id, opened.message.id));
    expect(row!.bodyText).toBe('Line one\nLine two');
  });

  // A refused send's paid upload budget made it wait up to an hour for an
  // answer the ticket gave at once.
  it('answers a closed ticket before the upload budget', async () => {
    const token = await minted();
    const session = await lookupSession(token, new Date());
    if (session.kind !== 'live') throw new Error('expected a live session');
    const ticket = (await sent(await create(token, [['text', 'Hello']]))).ticket;
    await db
      .update(conversations)
      .set({ statusId: await statusId('Closed') })
      .where(eq(conversations.id, ticket.id));
    // The hour's budget spent.
    const { spendUpload } = await import('@/lib/api/limits');
    spendUpload(session.caller.identityId, UPLOAD_BYTES_LIMIT);

    expect(await refusal(await send(token, ticket.id, [['files', photo()]]))).toMatchObject({
      status: 409,
      code: 'ticket_closed',
    });
  });

  it('spends the upload budget only on files stored, never on a failure or a replay', async () => {
    const token = await minted();
    const session = await lookupSession(token, new Date());
    if (session.kind !== 'live') throw new Error('expected a live session');
    const identity = session.caller.identityId;

    await refusal(await create(token, [['files', photo('bad.jpg', FAILING)]]));
    expect(uploadFits(identity, UPLOAD_BYTES_LIMIT).allowed).toBe(true);

    const key = randomUUID();
    await sent(await create(token, [['files', photo()]], key));
    await sent(await create(token, [['files', photo()]], key), 200);
    // The photo's bytes spent, by the one send that stored its file.
    expect(uploadFits(identity, UPLOAD_BYTES_LIMIT - JPEG.length).allowed).toBe(true);
    expect(uploadFits(identity, UPLOAD_BYTES_LIMIT - JPEG.length + 1).allowed).toBe(false);
  });
});

// --- Fetching one back ------------------------------------------------------

describe('GET /attachments/{id}', () => {
  async function ticketWithPhoto(token: string) {
    const result = await sent(
      await create(token, [
        ['text', 'Look'],
        ['files', photo()],
      ]),
    );
    return { ticket: result.ticket, attachmentId: result.message.attachments[0]!.id };
  }

  it('answers a five-minute link to a file on the user’s ticket, signed for its stored key', async () => {
    const token = await minted();
    const { attachmentId } = await ticketWithPhoto(token);

    const response = await link(token, attachmentId.toUpperCase());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = AttachmentLink.parse(await response.json());
    expect(body.expiresInSeconds).toBe(300);
    expect(storage.signed).toEqual([{ path: storage.uploaded[0], expiresInSeconds: 300 }]);
  });

  it('answers a file on a reply the team wrote on the user’s ticket', async () => {
    const token = await minted();
    const { ticket } = await ticketWithPhoto(token);
    const [agent] = await db
      .insert(agents)
      .values({ name: 'Omar', email: `omar${seq}@shipblu.test`, role: 'agent' })
      .returning({ id: agents.id });
    const [reply] = await db
      .insert(messages)
      .values({
        conversationId: ticket.id,
        direction: 'outbound',
        kind: 'reply',
        authorAgentId: agent!.id,
        bodyText: 'The label',
      })
      .returning({ id: messages.id });
    const [file] = await db
      .insert(attachments)
      .values({
        messageId: reply!.id,
        storagePath: `conversations/${ticket.id}/label.pdf`,
        filename: 'label.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
      })
      .returning({ id: attachments.id });

    expect((await link(token, file!.id)).status).toBe(200);
  });

  it('is 404 for another user’s file, a note’s, an inline one, a web chat file, a deleted ticket’s and a malformed id', async () => {
    const token = await minted();
    const other = await minted(`${user}_other`);
    const { ticket, attachmentId } = await ticketWithPhoto(token);

    const fileOn = async (messageValues: Partial<typeof messages.$inferInsert>, inline = false) => {
      const [message] = await db
        .insert(messages)
        .values({
          conversationId: ticket.id,
          direction: 'outbound',
          kind: 'reply',
          bodyText: 'x',
          ...messageValues,
        })
        .returning({ id: messages.id });
      const [file] = await db
        .insert(attachments)
        .values({
          messageId: message!.id,
          storagePath: `conversations/${ticket.id}/${randomUUID()}.jpg`,
          filename: 'x.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 1,
          isInline: inline,
        })
        .returning({ id: attachments.id });
      return file!.id;
    };

    const note = await fileOn({ kind: 'note' });
    const inline = await fileOn({}, true);

    const [contact] = await db
      .insert(contacts)
      .values({ name: 'Visitor' })
      .returning({ id: contacts.id });
    const [webchat] = await db
      .insert(conversations)
      .values({
        channel: 'webchat',
        statusId: await statusId('Open'),
        requesterContactId: contact!.id,
      })
      .returning({ id: conversations.id });
    const [chatMessage] = await db
      .insert(messages)
      .values({ conversationId: webchat!.id, direction: 'inbound', kind: 'reply', bodyText: 'x' })
      .returning({ id: messages.id });
    const [chatFile] = await db
      .insert(attachments)
      .values({
        messageId: chatMessage!.id,
        storagePath: `conversations/${webchat!.id}/x.jpg`,
        filename: 'x.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1,
      })
      .returning({ id: attachments.id });

    for (const [token_, id] of [
      [other, attachmentId],
      [token, note],
      [token, inline],
      [token, chatFile!.id],
      [token, 'not-a-uuid'],
      [token, randomUUID()],
    ] as const) {
      expect(await refusal(await link(token_, id))).toMatchObject({
        status: 404,
        code: 'not_found',
      });
    }

    await db
      .update(conversations)
      .set({ deletedAt: new Date() })
      .where(eq(conversations.id, ticket.id));
    expect(await refusal(await link(token, attachmentId))).toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(storage.signed).toEqual([]);
  });
});
