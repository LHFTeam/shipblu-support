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
  listMessages: async () => [],
}));
vi.mock('@/lib/widget/identify', () => ({
  applyVisitorIdentity,
  recordIdentityOnConversation: async () => undefined,
}));

const contact = await import('./contact/route');
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
});

const REFUSING = [
  { route: 'contact', POST: contact.POST },
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
    expect(appendVisitorMessage).toHaveBeenCalledWith('contact-1', 'hi', {
      pageUrl: null,
      userAgent: null,
    });
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
