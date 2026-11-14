import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stubFetch } from '@/lib/testing/fetch';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import {
  MessageCreatedEvent,
  WebhookEvent,
  WebhookSignatureHeader,
  WebhookTimestampHeader,
} from './schemas';
import {
  decideMessageCreated,
  deliverWebhook,
  MAX_EVENT_AGE_MS,
  messageCreatedEvent,
  signatureHeader,
  webhookTarget,
  WEBHOOK_TIMEOUT_MS,
  type MessageSubject,
} from './webhook';

/**
 * The webhook as the receiver sees it (`docs/myblu-api.md`, _The webhook_):
 * the bytes, the signature over them, and when the job sends nothing.
 *
 * The guide is read here rather than copied, so what it prints and what the
 * job sends cannot drift apart: its test vector is recomputed by the function
 * that signs, its body is rebuilt by the function that builds one, and its
 * own `verify` — the one myBlu's backend is told to copy — is run against an
 * attempt the job makes.
 */

const GUIDE = readFileSync(join(process.cwd(), 'docs/myblu-api.md'), 'utf8');

/** The four lines under _The test vector_, as the guide prints them. */
function guideVector() {
  const section = GUIDE.slice(GUIDE.indexOf('### The test vector'));
  const block = /```text\n([\s\S]*?)\n```/.exec(section)?.[1];
  if (!block) throw new Error('docs/myblu-api.md has no test vector block');
  const line = (name: string) => {
    const found = block.split('\n').find((l) => l.startsWith(`${name}: `));
    if (found === undefined) throw new Error(`the test vector has no ${name} line`);
    return found.slice(name.length + 2);
  };
  return {
    secret: line('secret'),
    timestamp: line('timestamp'),
    body: line('body'),
    signature: line('signature'),
  };
}

/** The guide's JavaScript `verify`, written to a file of its own and imported, as a receiver would copy it. */
async function guideVerify(): Promise<
  (
    rawBody: Buffer | string,
    timestamp: string | null,
    signature: string | null,
    secret: string,
    now?: number,
  ) => boolean
> {
  const section = GUIDE.slice(GUIDE.indexOf('### Receiving the webhook'));
  const code = /```js\n([\s\S]*?)\n```/.exec(section)?.[1];
  if (!code) throw new Error('docs/myblu-api.md has no JavaScript verify');
  const file = join(mkdtempSync(join(tmpdir(), 'myblu-verify-')), 'verify.mjs');
  writeFileSync(file, code);
  const copied = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    verify: Awaited<ReturnType<typeof guideVerify>>;
  };
  return copied.verify;
}

describe('the guide’s test vector', () => {
  it('is signed as signatureHeader signs', () => {
    const vector = guideVector();

    expect(signatureHeader([vector.secret], vector.timestamp, vector.body)).toBe(vector.signature);
    expect(WebhookSignatureHeader.parse(vector.signature)).toBe(vector.signature);
    expect(WebhookTimestampHeader.parse(vector.timestamp)).toBe(vector.timestamp);
  });

  it('is byte for byte the body messageCreatedEvent builds for its values', () => {
    const vector = guideVector();
    const parsed = MessageCreatedEvent.parse(JSON.parse(vector.body));

    const built = messageCreatedEvent({
      messageId: parsed.message.id,
      from: parsed.message.from,
      occurredAt: new Date(parsed.occurredAt),
      externalId: parsed.user.externalId,
      ticket: parsed.ticket,
    });

    expect(JSON.stringify(built)).toBe(vector.body);
  });

  it('is the example delivery the guide prints above it', () => {
    const vector = guideVector();
    const section = GUIDE.slice(GUIDE.indexOf('## The webhook'));
    const headers = /```text\n([\s\S]*?)\n```/.exec(section)![1]!;
    const example = /```json\n([\s\S]*?)\n```/.exec(section)![1]!;

    expect(headers).toContain(`X-ShipBlu-Timestamp: ${vector.timestamp}`);
    expect(headers).toContain(`X-ShipBlu-Signature: ${vector.signature}`);
    expect(JSON.parse(example)).toEqual(JSON.parse(vector.body));
  });

  it('is accepted by the guide’s own verify, and refused once a byte changes', async () => {
    const verify = await guideVerify();
    const { secret, timestamp, body, signature } = guideVector();
    const now = Number(timestamp);

    expect(verify(Buffer.from(body), timestamp, signature, secret, now)).toBe(true);
    expect(verify(Buffer.from(`${body} `), timestamp, signature, secret, now)).toBe(false);
    expect(verify(Buffer.from(body), String(now + 1), signature, secret, now)).toBe(false);
    // The five-minute rule, which the vector is signed too long ago to pass.
    expect(verify(Buffer.from(body), timestamp, signature, secret)).toBe(false);
  });
});

describe('signatureHeader', () => {
  it('signs under each secret, the current one first, in the shape the contract publishes', () => {
    const header = signatureHeader(['c'.repeat(32), 'p'.repeat(32)], '1794476469', '{}');
    const [current, previous] = header.split(',');

    expect(WebhookSignatureHeader.parse(header)).toBe(header);
    expect(current).toBe(
      `v1=${createHmac('sha256', 'c'.repeat(32)).update('1794476469.{}').digest('hex')}`,
    );
    expect(previous).toBe(
      `v1=${createHmac('sha256', 'p'.repeat(32)).update('1794476469.{}').digest('hex')}`,
    );
  });
});

const SECRET = 'webhook-unit-secret-0123456789-abcdef';
const PREVIOUS = 'webhook-unit-previous-0123456789-abcd';
const RECEIVER = 'https://myblu.example.test/support/webhook/';

describe('webhookTarget', () => {
  withTestEnv({ MYBLU_WEBHOOK_URL: RECEIVER, MYBLU_WEBHOOK_SECRET: SECRET });

  it('is ready with the URL exactly as set, and the secret', () => {
    expect(webhookTarget()).toEqual({
      kind: 'ready',
      target: { url: RECEIVER, secrets: [SECRET] },
    });
  });

  it('signs with the previous secret beside the current one while it is set', () => {
    setTestEnv({ MYBLU_WEBHOOK_SECRET_PREVIOUS: PREVIOUS });
    expect(webhookTarget()).toEqual({
      kind: 'ready',
      target: { url: RECEIVER, secrets: [SECRET, PREVIOUS] },
    });

    setTestEnv({ MYBLU_WEBHOOK_SECRET_PREVIOUS: 'short' });
    expect(webhookTarget()).toEqual({
      kind: 'ready',
      target: { url: RECEIVER, secrets: [SECRET] },
    });
  });

  it('is off while the URL is unset or blank', () => {
    setTestEnv({ MYBLU_WEBHOOK_URL: undefined });
    expect(webhookTarget()).toEqual({ kind: 'off' });
    setTestEnv({ MYBLU_WEBHOOK_URL: '  ' });
    expect(webhookTarget()).toEqual({ kind: 'off' });
  });

  // Each value carries a credential-shaped string, which the reason must never repeat.
  it.each([
    ['http://myblu.example.test/hook', 'is not https'],
    ['https://user:hunter2-password@myblu.example.test/hook', 'carries userinfo'],
    ['https://hunter2-password@myblu.example.test/hook', 'carries userinfo'],
    ['https://myblu.example.test/hook?token=hunter2-password', 'carries a query string'],
    ['https://myblu.example.test/hook?', 'carries a query string'],
    ['myblu.example.test/hook/hunter2-password', 'is not a URL'],
  ])('refuses %s, saying why and never what it holds', (url, why) => {
    setTestEnv({ MYBLU_WEBHOOK_URL: url });
    const target = webhookTarget();

    expect(target).toEqual({ kind: 'refused', reason: expect.stringContaining(why) });
    expect(JSON.stringify(target)).not.toContain('hunter2');
  });

  it('refuses a URL with no secret, or one under 32 characters, and never repeats it', () => {
    setTestEnv({ MYBLU_WEBHOOK_SECRET: undefined, MYBLU_WEBHOOK_SECRET_PREVIOUS: PREVIOUS });
    expect(webhookTarget()).toMatchObject({ kind: 'refused' });

    setTestEnv({ MYBLU_WEBHOOK_SECRET: 's'.repeat(31) });
    const target = webhookTarget();
    expect(target).toEqual({
      kind: 'refused',
      reason: expect.stringContaining('MYBLU_WEBHOOK_SECRET is unset or shorter than 32'),
    });
    expect(JSON.stringify(target)).not.toContain('s'.repeat(31));
  });
});

const NOW = new Date('2026-11-12T10:00:00.000Z');

/** A reply an agent wrote on an app ticket a minute ago, whose owner can read it. */
function subject(overrides: Partial<MessageSubject> = {}): MessageSubject {
  return {
    messageId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    direction: 'outbound',
    kind: 'reply',
    byAgent: true,
    createdAt: new Date(NOW.getTime() - 60_000),
    ticketId: '8a1f4c2e-6b3d-4f9a-a7e5-1c2d3e4f5a6b',
    number: 4812,
    channel: 'api',
    status: 'open',
    withdrawn: false,
    requesterContactId: 'contact-1',
    owner: {
      identifier: 'myblu:u_83412',
      contactId: 'contact-1',
      isBlocked: false,
      deletedAt: null,
    },
    ...overrides,
  };
}

describe('decideMessageCreated', () => {
  it('sends a reply from the team on an app ticket its owner can read, as the contract shapes it', () => {
    const decision = decideMessageCreated(subject(), NOW);

    expect(decision).toEqual({
      kind: 'send',
      event: {
        version: 1,
        id: 'message.created:6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
        type: 'message.created',
        occurredAt: '2026-11-12T09:59:00.000Z',
        user: { externalId: 'u_83412' },
        ticket: { id: '8a1f4c2e-6b3d-4f9a-a7e5-1c2d3e4f5a6b', number: 4812, status: 'open' },
        message: { id: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f', from: 'agent' },
      },
    });
    if (decision.kind !== 'send') throw new Error('unreachable');
    // Every key it sends is one the contract publishes, so a receiver
    // validating strictly against the document takes it.
    expect(MessageCreatedEvent.strict().parse(decision.event)).toEqual(decision.event);
    expect(WebhookEvent.parse(decision.event)).toEqual(decision.event);
  });

  it('calls a reply nobody on the team wrote `system`, as the thread does', () => {
    const decision = decideMessageCreated(subject({ byAgent: false }), NOW);
    expect(decision).toMatchObject({ kind: 'send', event: { message: { from: 'system' } } });
  });

  it('sends the status the ticket has now', () => {
    expect(decideMessageCreated(subject({ status: 'resolved' }), NOW)).toMatchObject({
      event: { ticket: { status: 'resolved' } },
    });
  });

  it.each([
    ['a note', { kind: 'note' }],
    ['a system row', { kind: 'system' }],
    ['the customer’s own message', { direction: 'inbound' as const }],
    ['a web chat reply', { channel: 'webchat' }],
    ['a WhatsApp reply', { channel: 'whatsapp' }],
  ])('refuses %s, whatever the ticket is like', (_, overrides) => {
    expect(decideMessageCreated(subject({ ...overrides, withdrawn: true }), NOW)).toMatchObject({
      kind: 'refuse',
    });
  });

  it('sends nothing on a ticket deleted, marked spam or merged away', () => {
    expect(decideMessageCreated(subject({ withdrawn: true }), NOW)).toEqual({
      kind: 'quiet',
      reason: 'withdrawn',
    });
  });

  it.each([
    ['no ownership row: an account deleted or a number released', { owner: null }],
    [
      'a requester that is not the owner’s contact, which the app cannot read either',
      { requesterContactId: 'contact-2' },
    ],
    [
      'an owner whose identity is not myBlu’s',
      {
        owner: { identifier: 'u_83412', contactId: 'contact-1', isBlocked: false, deletedAt: null },
      },
    ],
  ])('sends nothing for %s', (_, overrides) => {
    expect(decideMessageCreated(subject(overrides), NOW)).toEqual({
      kind: 'quiet',
      reason: 'not_in_app',
    });
  });

  it('sends nothing to a user every request of whose is refused', () => {
    const owner = subject().owner!;
    expect(decideMessageCreated(subject({ owner: { ...owner, isBlocked: true } }), NOW)).toEqual({
      kind: 'quiet',
      reason: 'refused',
    });
    expect(decideMessageCreated(subject({ owner: { ...owner, deletedAt: NOW } }), NOW)).toEqual({
      kind: 'quiet',
      reason: 'refused',
    });
  });

  it('sends nothing for an event older than its day allows, and sends one on the edge', () => {
    const edge = new Date(NOW.getTime() - MAX_EVENT_AGE_MS);
    expect(decideMessageCreated(subject({ createdAt: edge }), NOW).kind).toBe('send');
    expect(decideMessageCreated(subject({ createdAt: new Date(edge.getTime() - 1) }), NOW)).toEqual(
      { kind: 'quiet', reason: 'stale' },
    );
  });
});

describe('deliverWebhook', () => {
  const target = { url: RECEIVER, secrets: [SECRET, PREVIOUS] };
  const event = messageCreatedEvent({
    messageId: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    from: 'agent',
    occurredAt: new Date('2026-11-12T09:41:07.004Z'),
    externalId: 'u_83412',
    ticket: { id: '8a1f4c2e-6b3d-4f9a-a7e5-1c2d3e4f5a6b', number: 4812, status: 'open' },
  });

  it('posts the signed event to the URL as set, follows no redirect, and gives up at its deadline', async () => {
    const fetchMock = stubFetch(() => new Response('ok', { status: 202 }));

    await expect(deliverWebhook(target, event, NOW)).resolves.toBe(202);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(RECEIVER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init!.headers);
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(headers.get('x-shipblu-event')).toBe('message.created');
    expect(headers.get('x-shipblu-event-id')).toBe(event.id);
    expect(headers.get('x-shipblu-timestamp')).toBe(String(NOW.getTime() / 1000));
    expect(JSON.parse(init!.body as string)).toEqual(event);
  });

  it('sends what the guide’s verify accepts, under either secret during a rotation', async () => {
    const verify = await guideVerify();
    const fetchMock = stubFetch(() => new Response(null, { status: 200 }));

    await deliverWebhook(target, event, NOW);

    const init = fetchMock.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    const now = NOW.getTime() / 1000;
    const body = Buffer.from(init.body as string);
    for (const secret of [SECRET, PREVIOUS]) {
      expect(
        verify(
          body,
          headers.get('x-shipblu-timestamp'),
          headers.get('x-shipblu-signature'),
          secret,
          now,
        ),
      ).toBe(true);
    }
    expect(
      verify(
        body,
        headers.get('x-shipblu-timestamp'),
        headers.get('x-shipblu-signature'),
        'x'.repeat(40),
        now,
      ),
    ).toBe(false);
  });

  it.each([301, 400, 401, 404, 500, 503])(
    'throws a plain error, for the queue to retry, when the receiver answers %i',
    async (status) => {
      stubFetch(() => new Response('<html>a receiver’s error page</html>', { status }));

      const failure = await deliverWebhook(target, event, NOW).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe('WebhookNotTaken');
      expect((failure as Error).message).toBe(`the receiver answered ${status}`);
    },
  );

  it('throws when the receiver takes longer than its deadline, saying so', async () => {
    stubFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    await expect(deliverWebhook(target, event, NOW)).rejects.toThrow(
      `the receiver did not answer within ${WEBHOOK_TIMEOUT_MS / 1000} s`,
    );
  });

  it('throws when the request never gets an answer, a refused redirect included', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    });

    await expect(deliverWebhook(target, event, NOW)).rejects.toThrow(
      'no answer from the receiver: a redirect, or the connection, TLS or DNS failed',
    );
  });
});
