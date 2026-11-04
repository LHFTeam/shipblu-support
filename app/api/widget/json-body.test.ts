import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the widget's routes answer for a body they cannot use.
 *
 * The widget parses these answers, so their bodies are pinned byte for byte:
 * `{"error":"invalid json"}` from the three routes that refuse one, and a fresh
 * session from the one that starts over instead. Each route read its body with
 * `(await request.json()) as typeof body` inside a `try`, which let JSON `null`
 * through to the first field read — a 500 where every other unusable body gets
 * the route's own answer. A body that is JSON but not an object is now refused
 * as invalid JSON, and is the one answer here that changed on purpose.
 */

const resolveVisitor = vi.fn(async (token: string) => (token === 'known' ? 'contact-1' : null));
const registerVisitor = vi.fn(async () => ({ contactId: 'contact-new' }));
const appendVisitorMessage = vi.fn(async () => ({ conversationId: 'conversation-1' }));
const attachVisitorDetails = vi.fn(async () => undefined);
const applyVisitorIdentity = vi.fn(async () => 'applied');
const answerSurvey = vi.fn(async (): Promise<number | null> => 4);

vi.mock('@/lib/widget/session', () => ({
  resolveVisitor,
  registerVisitor,
  issueVisitorToken: () => 'fresh-token',
  findLiveConversation: async () => null,
  hasReplyDetails: async () => false,
  widgetHours: async () => null,
}));
vi.mock('@/lib/widget/conversation', () => ({
  appendVisitorMessage,
  attachVisitorDetails,
  answerSurvey,
  listMessages: async () => [],
  VisitorUploadFailed: class VisitorUploadFailed extends Error {},
}));
/* What `megabytesOf` answers, when a test needs a send to weigh more than its bytes. */
const weighs = vi.hoisted(() => ({ megabytes: null as number | null }));
vi.mock('@/lib/widget/uploads', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/widget/uploads')>();
  return {
    ...real,
    megabytesOf: (uploads: Parameters<typeof real.megabytesOf>[0]) =>
      weighs.megabytes ?? real.megabytesOf(uploads),
  };
});
vi.mock('@/lib/widget/identify', () => ({
  applyVisitorIdentity,
  recordIdentityOnConversation: async () => undefined,
}));

const contact = await import('./contact/route');
const csat = await import('./csat/route');
const identify = await import('./identify/route');
const message = await import('./message/route');
const session = await import('./session/route');

// A fresh address per request, so no test spends another's rate limit.
let address = 0;
function post(body: string): Request {
  address += 1;
  return new Request('https://support.example/api/widget', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.${Math.floor(address / 250)}.${address % 250}`,
    },
  });
}

beforeEach(() => {
  resolveVisitor.mockClear();
  registerVisitor.mockClear();
  appendVisitorMessage.mockClear();
  attachVisitorDetails.mockClear();
  applyVisitorIdentity.mockClear();
  answerSurvey.mockClear();
});

const REFUSING = [
  { route: 'contact', POST: contact.POST },
  { route: 'csat', POST: csat.POST },
  { route: 'identify', POST: identify.POST },
  { route: 'message', POST: message.POST },
];

describe.each(REFUSING)('POST /api/widget/$route', ({ POST }) => {
  async function refusedAsInvalidJson(response: Response): Promise<void> {
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":"invalid json"}');
    expect(resolveVisitor).not.toHaveBeenCalled();
  }

  it('refuses a body that is not JSON', async () => {
    await refusedAsInvalidJson(await POST(post('{not json')));
  });

  it('refuses JSON null the same way, rather than with a 500', async () => {
    await refusedAsInvalidJson(await POST(post('null')));
  });

  // A number, a string or an array used to be read as an object with no token,
  // and answered 401. The widget never sends one; refusing it as the JSON it is
  // not is the answer that says what is wrong with it.
  it.each(['5', '"text"', '[]'])('refuses JSON that is not an object: %s', async (body) => {
    await refusedAsInvalidJson(await POST(post(body)));
  });

  it('asks who the visitor is for any object, whatever it holds', async () => {
    const response = await POST(post(JSON.stringify({ token: 5 })));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"unknown session"}');
    expect(resolveVisitor).toHaveBeenCalledWith('');
  });
});

describe('a usable widget body', () => {
  it('appends a message from a known visitor', async () => {
    const response = await message.POST(post(JSON.stringify({ token: 'known', body: ' hi ' })));

    expect(response.status).toBe(200);
    expect(appendVisitorMessage).toHaveBeenCalledWith(
      'contact-1',
      'hi',
      { pageUrl: null, userAgent: null },
      [],
    );
  });

  it('passes the identity object through untouched', async () => {
    const identity = { email: 'merchant@example.com', name: 'Merchant' };

    await identify.POST(post(JSON.stringify({ token: 'known', identity })));

    expect(applyVisitorIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'contact-1', verified: false }),
    );
  });

  it('attaches the details a visitor left', async () => {
    const response = await contact.POST(
      post(JSON.stringify({ token: 'known', email: 'visitor@example.com' })),
    );

    // No live conversation in this test, so the route refuses at the step after
    // the body has been read and the details parsed.
    expect(await response.text()).toBe('{"error":"no conversation"}');
  });
});

describe('POST /api/widget/csat', () => {
  const SURVEY = '6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7';

  it('answers for the visitor the token names, with the comment as text or not at all', async () => {
    const response = await csat.POST(
      post(JSON.stringify({ token: 'known', surveyId: SURVEY, rating: 4, comment: ' quick ' })),
    );

    expect(await response.text()).toBe('{"rating":4}');
    expect(answerSurvey).toHaveBeenCalledWith('contact-1', SURVEY, 4, ' quick ');

    await csat.POST(
      post(JSON.stringify({ token: 'known', surveyId: SURVEY, rating: 2, comment: 7 })),
    );
    expect(answerSurvey).toHaveBeenLastCalledWith('contact-1', SURVEY, 2, null);
  });

  it("answers a survey that is not the visitor's as it answers one that does not exist", async () => {
    answerSurvey.mockResolvedValueOnce(null);
    const response = await csat.POST(
      post(JSON.stringify({ token: 'known', surveyId: SURVEY, rating: 5 })),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"rating":null}');
  });

  it('refuses a survey id that is not a uuid before it reaches a query, and a rating off the scale', async () => {
    const bad = await csat.POST(post(JSON.stringify({ token: 'known', surveyId: 'x', rating: 3 })));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toBe('{"error":"no survey"}');

    const unrated = await csat.POST(post(JSON.stringify({ token: 'known', surveyId: SURVEY })));
    expect(await unrated.text()).toBe('{"error":"no rating"}');
    // Off the scale is refused here, not answered `{"rating":null}`, which
    // the card reads as a survey that has closed.
    for (const rating of [0, 6, 4.5]) {
      const off = await csat.POST(
        post(JSON.stringify({ token: 'known', surveyId: SURVEY, rating })),
      );
      expect(off.status).toBe(400);
      expect(await off.text()).toBe('{"error":"no rating"}');
    }
    expect(answerSurvey).not.toHaveBeenCalled();
  });
});

describe('POST /api/widget/session', () => {
  async function startedOver(response: Response): Promise<void> {
    expect(response.status).toBe(200);
    expect(((await response.json()) as { token: string }).token).toBe('fresh-token');
    expect(registerVisitor).toHaveBeenCalledOnce();
  }

  it('starts a fresh session for a body that is not JSON', async () => {
    await startedOver(await session.POST(post('{not json')));
  });

  it('starts a fresh session for JSON null, rather than failing with a 500', async () => {
    await startedOver(await session.POST(post('null')));
  });

  it('starts a fresh session for JSON that is not an object', async () => {
    await startedOver(await session.POST(post('5')));
  });

  it('resumes the session a known token names', async () => {
    const response = await session.POST(post(JSON.stringify({ token: 'known' })));

    expect(((await response.json()) as { token: string }).token).toBe('known');
    expect(registerVisitor).not.toHaveBeenCalled();
  });
});

/**
 * A message with files, which the widget sends as a multipart body. The files
 * are judged by the composer's own rules and then by their bytes, and only a
 * message whose every file passes reaches `appendVisitorMessage`.
 */
describe('POST /api/widget/message with files', () => {
  const JPEG = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0,
  ]);

  function multipart(fields: Record<string, string>, files: File[] = []): Request {
    address += 1;
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    for (const file of files) form.append('files', file, file.name);
    return new Request('https://support.example/api/widget/message', {
      method: 'POST',
      body: form,
      headers: { 'x-forwarded-for': `203.0.${Math.floor(address / 250)}.${address % 250}` },
    });
  }

  it('stores a photo sent with no words, typed by its bytes', async () => {
    const photo = new File([JPEG], 'parcel.jpeg', { type: 'image/jpeg' });
    const response = await message.POST(multipart({ token: 'known', body: '' }, [photo]));

    expect(response.status).toBe(200);
    expect(appendVisitorMessage).toHaveBeenCalledWith(
      'contact-1',
      '',
      expect.objectContaining({ pageUrl: null }),
      [
        expect.objectContaining({
          filename: 'parcel.jpeg',
          contentType: 'image/jpeg',
          kind: 'image',
          extension: 'jpg',
        }),
      ],
    );
  });

  it('refuses a file whose bytes are not what its label says, by name', async () => {
    const page = new File(['<html><script>alert(1)</script></html>'], 'parcel.jpg', {
      type: 'image/jpeg',
    });
    const response = await message.POST(multipart({ token: 'known', body: 'look' }, [page]));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'type', filename: 'parcel.jpg' });
    expect(appendVisitorMessage).not.toHaveBeenCalled();
  });

  it('refuses a type the widget does not carry before reading it', async () => {
    const sheet = new File(['a,b'], 'orders.csv', { type: 'text/csv' });
    const response = await message.POST(multipart({ token: 'known', body: '' }, [sheet]));

    expect(await response.json()).toEqual({ error: 'type', filename: 'orders.csv' });
    expect(appendVisitorMessage).not.toHaveBeenCalled();
  });

  it('refuses more files than one message carries', async () => {
    const photos = Array.from(
      { length: 6 },
      (_, index) => new File([JPEG], `photo-${index}.jpg`, { type: 'image/jpeg' }),
    );
    const response = await message.POST(multipart({ token: 'known', body: '' }, photos));

    expect(await response.json()).toEqual({ error: 'too_many', filename: null });
    expect(appendVisitorMessage).not.toHaveBeenCalled();
  });

  it('refuses a body longer than the limit before reading it', async () => {
    address += 1;
    const response = await message.POST(
      new Request('https://support.example/api/widget/message', {
        method: 'POST',
        body: 'x',
        headers: {
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(40 * 1024 * 1024),
          'x-forwarded-for': `192.0.2.${address % 250}`,
        },
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'too_large_total' });
    expect(resolveVisitor).not.toHaveBeenCalled();
  });

  it('refuses a multipart body that holds neither words nor a file', async () => {
    const response = await message.POST(multipart({ token: 'known', body: '   ' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'empty message' });
  });

  it('refuses an empty file by name, rather than storing the words without it', async () => {
    const empty = new File([], 'memo.m4a', { type: 'audio/x-m4a' });
    const response = await message.POST(
      multipart({ token: 'known', body: 'here is the recording' }, [empty]),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'empty', filename: 'memo.m4a' });
    expect(appendVisitorMessage).not.toHaveBeenCalled();
  });

  it('answers a file Storage would not take with upload_failed, which the widget offers to retry', async () => {
    const { VisitorUploadFailed } = await import('@/lib/widget/conversation');
    appendVisitorMessage.mockRejectedValueOnce(new VisitorUploadFailed('no'));
    const photo = new File([JPEG], 'parcel.jpg', { type: 'image/jpeg' });

    const response = await message.POST(multipart({ token: 'known', body: '' }, [photo]));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'upload_failed' });
  });

  it('asks who the visitor is before judging the files', async () => {
    const photo = new File([JPEG], 'parcel.jpg', { type: 'image/jpeg' });
    const response = await message.POST(multipart({ token: 'stranger', body: '' }, [photo]));

    expect(response.status).toBe(401);
    expect(appendVisitorMessage).not.toHaveBeenCalled();
  });
});

/*
  Last in the file: it fills the known visitor's hourly budget, which every
  send with files from that token after it would then meet.
*/
describe('the hourly upload budget', () => {
  it('refuses a visitor’s send past it with slow_down, and stores nothing', async () => {
    const photo = () =>
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(12).fill(0)])], 'p.jpg', {
        type: 'image/jpeg',
      });
    const send = () => {
      address += 1;
      const form = new FormData();
      form.set('token', 'known');
      form.set('body', '');
      form.append('files', photo(), 'p.jpg');
      return message.POST(
        new Request('https://support.example/api/widget/message', {
          method: 'POST',
          body: form,
          headers: { 'x-forwarded-for': `192.0.2.${address % 250}` },
        }),
      );
    };

    weighs.megabytes = 60;
    try {
      expect((await send()).status).toBe(200);
      appendVisitorMessage.mockClear();

      const refused = await send();
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: 'slow_down' });
      expect(appendVisitorMessage).not.toHaveBeenCalled();
    } finally {
      weighs.megabytes = null;
    }
  });
});
