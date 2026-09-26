import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFetch } from '@/lib/testing/fetch';
import { STALLED_AFTER_MS } from '@/lib/queue';
import { PostmarkEmailProvider } from './postmark';

const provider = new PostmarkEmailProvider('token', 'webhook-secret-value');

function basicAuth(password: string, user = 'user'): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

const refused = (reason: RegExp) => ({ verified: false, reason: expect.stringMatching(reason) });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PostmarkEmailProvider.verifySignature', () => {
  it('accepts the configured secret', () => {
    expect(provider.verifySignature('{}', basicAuth('webhook-secret-value'))).toEqual({
      verified: true,
    });
  });

  it('rejects a wrong secret, and says so', () => {
    expect(provider.verifySignature('{}', basicAuth('wrong-secret-value'))).toEqual(
      refused(/did not match EMAIL_WEBHOOK_SECRET/),
    );
  });

  it('rejects a missing or malformed header', () => {
    expect(provider.verifySignature('{}', {})).toEqual(refused(/no Basic Auth/));
    expect(provider.verifySignature('{}', { authorization: 'Bearer abc' })).toEqual(
      refused(/no Basic Auth/),
    );
  });

  it('rejects a secret of a different length without throwing', () => {
    // timingSafeEqual throws on length mismatch, so this must be guarded.
    expect(() => provider.verifySignature('{}', basicAuth('short'))).not.toThrow();
    expect(provider.verifySignature('{}', basicAuth('short')).verified).toBe(false);
  });

  /**
   * A credential is `user:password`. Reading everything after `indexOf(':') + 1`
   * treated a token with no colon as all password, so the bare secret, encoded
   * on its own, authenticated.
   */
  it('rejects a credential with no password half, even when it is the secret itself', () => {
    const bare = {
      authorization: `Basic ${Buffer.from('webhook-secret-value').toString('base64')}`,
    };
    expect(provider.verifySignature('{}', bare)).toEqual(refused(/has no password/));
  });

  it('reads the scheme case-insensitively, as RFC 7617 says it is', () => {
    const lower = {
      authorization: basicAuth('webhook-secret-value').authorization!.replace('Basic', 'basic'),
    };
    expect(provider.verifySignature('{}', lower)).toEqual({ verified: true });
  });
});

/**
 * An unset secret used to mean "accept everything", with a warning, so a
 * deploy that lost the variable took forged mail for customer mail and said so
 * only in a log line. It now refuses everywhere — the answer WhatsApp and Meta
 * give an empty app secret — and says why on the row it stores.
 */
describe('PostmarkEmailProvider.verifySignature without a secret', () => {
  it('refuses every delivery, whatever it presents', () => {
    const unset = new PostmarkEmailProvider('token', undefined);

    expect(unset.verifySignature('{}', {})).toEqual(refused(/EMAIL_WEBHOOK_SECRET is not set/));
    expect(unset.verifySignature('{}', basicAuth('anything'))).toEqual(
      refused(/EMAIL_WEBHOOK_SECRET is not set/),
    );
  });

  /**
   * An empty secret is one anyone can match: `user:` decodes to an empty
   * password, and two zero-length buffers compare equal. So a blank value on
   * Render has to count as unset, not as a secret.
   */
  it('treats an empty value as unset, because an empty password would match it', () => {
    const blank = new PostmarkEmailProvider('token', '');

    expect(blank.verifySignature('{}', basicAuth(''))).toEqual(
      refused(/EMAIL_WEBHOOK_SECRET is not set/),
    );
  });
});

describe('PostmarkEmailProvider.parseInbound', () => {
  const payload = {
    MessageID: '<abc-123@postmark>',
    FromFull: { Email: 'Customer@Example.com', Name: 'A Customer' },
    ToFull: [{ Email: 'support@shipblu.com' }],
    CcFull: [{ Email: 'colleague@example.com', Name: 'Colleague' }],
    OriginalRecipient: 'support+c42.deadbeefdeadbeef@shipblu.com',
    Subject: 'Re: parcel',
    TextBody: 'still waiting',
    HtmlBody: '<p>still waiting</p>',
    Date: '2026-08-17T10:00:00Z',
    Headers: [
      { Name: 'In-Reply-To', Value: '<parent@shipblu.com>' },
      { Name: 'References', Value: '<root@shipblu.com> <parent@shipblu.com>' },
      { Name: 'Auto-Submitted', Value: 'auto-replied' },
      { Name: 'Received-SPF', Value: 'pass (example.com: domain of x designates y)' },
    ],
    Attachments: [
      {
        Name: 'receipt.pdf',
        Content: Buffer.from('hello').toString('base64'),
        ContentType: 'application/pdf',
        ContentLength: 5,
      },
      {
        Name: 'logo.png',
        Content: Buffer.from('img').toString('base64'),
        ContentType: 'image/png',
        ContentLength: 3,
        ContentID: 'logo123',
      },
    ],
  };

  it("prefers the sender's real Message-ID over Postmark's internal id", async () => {
    // Postmark's MessageID is its own UUID. Storing that as the message's
    // channel id would leave a later reply's References — which quote the real
    // header — matching against an id no mail client has ever seen.
    const parsed = await provider.parseInbound({
      ...payload,
      MessageID: 'e4f9b1c2-0000-4a11-9b33-postmarkuuid',
      Headers: [...payload.Headers, { Name: 'Message-ID', Value: '<real-sender-id@gmail.com>' }],
    });

    expect(parsed.messageId).toBe('real-sender-id@gmail.com');
  });

  it('maps the payload into the provider-agnostic shape', async () => {
    const parsed = await provider.parseInbound(payload);

    expect(parsed.messageId).toBe('abc-123@postmark');
    expect(parsed.from).toEqual({ address: 'Customer@Example.com', name: 'A Customer' });
    expect(parsed.subject).toBe('Re: parcel');
    expect(parsed.textBody).toBe('still waiting');
  });

  it('strips angle brackets from threading headers', async () => {
    const parsed = await provider.parseInbound(payload);
    expect(parsed.inReplyTo).toBe('parent@shipblu.com');
    expect(parsed.references).toEqual(['root@shipblu.com', 'parent@shipblu.com']);
  });

  it('exposes the envelope recipient so plus-address threading survives forwarding', async () => {
    const parsed = await provider.parseInbound(payload);
    expect(parsed.deliveredTo).toEqual(['support+c42.deadbeefdeadbeef@shipblu.com']);
  });

  it('lowercases header names so loop protection can find them', async () => {
    const parsed = await provider.parseInbound(payload);
    expect(parsed.headers['auto-submitted']).toBe('auto-replied');
  });

  it('decodes attachments and marks inline ones', async () => {
    const parsed = await provider.parseInbound(payload);
    expect(parsed.attachments).toHaveLength(2);

    const [doc, image] = parsed.attachments;
    expect(doc!.content.toString()).toBe('hello');
    expect(doc!.isInline).toBe(false);
    // A ContentID means the HTML body references it via cid:, so it must render
    // inline rather than appearing as a stray download.
    expect(image!.isInline).toBe(true);
    expect(image!.contentId).toBe('logo123');
  });

  it('reads the SPF result', async () => {
    const parsed = await provider.parseInbound(payload);
    expect(parsed.spfPass).toBe(true);
  });

  it('throws when there is no sender rather than inventing one', async () => {
    await expect(provider.parseInbound({ Subject: 'x' })).rejects.toThrow(/no sender/i);
  });

  it('tolerates a minimal payload', async () => {
    const parsed = await provider.parseInbound({
      FromFull: { Email: 'a@b.com' },
    });
    expect(parsed.to).toEqual([]);
    expect(parsed.references).toEqual([]);
    expect(parsed.subject).toBe('');
    expect(parsed.attachments).toEqual([]);
  });
});

describe('PostmarkEmailProvider.send', () => {
  const email = {
    to: [{ address: 'customer@example.com' }],
    from: { address: 'support@shipblu.com', name: 'ShipBlu Support' },
    replyTo: 'support+c42.deadbeefdeadbeef@shipblu.com',
    subject: 'Re: parcel [#42.deadbeefdeadbeef]',
    textBody: 'On its way.',
    htmlBody: '<p>On its way.</p>',
    messageId: 'our-generated-id@shipblu.com',
    inReplyTo: 'parent@shipblu.com',
    references: ['root@shipblu.com', 'parent@shipblu.com'],
  };

  async function capture(response: unknown) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];

    stubFetch(async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json(response);
    });

    const result = await provider.send(email);
    return { result, url: calls[0]!.url, sent: calls[0]!.body };
  }

  // The stream is not checked by anything else. A name Postmark does not know is
  // refused, but `broadcast` exists on every server and is accepted: a
  // customer's reply would go out on the bulk-mail stream, with its unsubscribe
  // handling, and nothing in the response says which stream was used.
  it('sends to the email endpoint, on the transactional stream', async () => {
    const { url, sent } = await capture({ MessageID: 'x' });

    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(sent).toMatchObject({
      From: '"ShipBlu Support" <support@shipblu.com>',
      To: 'customer@example.com',
      ReplyTo: 'support+c42.deadbeefdeadbeef@shipblu.com',
      Subject: 'Re: parcel [#42.deadbeefdeadbeef]',
      TextBody: 'On its way.',
      HtmlBody: '<p>On its way.</p>',
      MessageStream: 'outbound',
    });
  });

  it('reports the Postmark UUID as a provider id, never as an RFC message id', async () => {
    const { result } = await capture({ MessageID: 'e4f9b1c2-0000-4a11-9b33-postmarkuuid' });

    expect(result.providerMessageId).toBe('e4f9b1c2-0000-4a11-9b33-postmarkuuid');
    // The two are different things. rfcMessageId staying null is what makes
    // send-email keep our own id as the message's channel id.
    expect(result.rfcMessageId).toBeNull();
    expect(result.accepted).toBe(true);
  });

  it('sets the threading headers in angle-bracket form', async () => {
    const { sent } = await capture({ MessageID: 'x' });
    const headers = sent.Headers as { Name: string; Value: string }[];
    const byName = Object.fromEntries(headers.map((h) => [h.Name, h.Value]));

    expect(byName['Message-ID']).toBe('<our-generated-id@shipblu.com>');
    expect(byName['In-Reply-To']).toBe('<parent@shipblu.com>');
    expect(byName['References']).toBe('<root@shipblu.com> <parent@shipblu.com>');
  });

  it('throws on a provider error so the queue retries with backoff', async () => {
    stubFetch(
      async () =>
        new Response('{"ErrorCode":300,"Message":"Invalid \'From\' address"}', { status: 422 }),
    );

    await expect(provider.send(email)).rejects.toThrow(/422/);
  });
});

/**
 * Every Postmark send runs in a job, and it had no deadline of its own: `fetch`
 * gives up only after five minutes without a response, and every queued job
 * waited behind it, because the worker awaits a batch before it claims the
 * next. A send's deadline has two edges — below about a minute, an email
 * Postmark was still accepting is given up on and sent again; past the
 * stalled-job window, a deploy's new worker can reclaim the job mid-send and
 * run it twice.
 */
describe('PostmarkEmailProvider.send deadline', () => {
  const email = {
    to: [{ address: 'customer@example.com' }],
    from: { address: 'support@shipblu.com' },
    replyTo: 'support@shipblu.com',
    subject: 'Re: parcel',
    textBody: 'On its way.',
    htmlBody: '<p>On its way.</p>',
    messageId: 'our-generated-id@shipblu.com',
  };

  beforeEach(() => {
    // Answers like `fetch` does: a signal that has fired rejects with its reason.
    stubFetch(async (_url: string | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(JSON.stringify({ MessageID: 'pm-1' }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sits between a minute and the window after which the queue runs a job again', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    await provider.send(email);

    const deadline = timeout.mock.calls[0]?.[0] ?? 0;
    expect(deadline).toBeGreaterThanOrEqual(60_000);
    expect(deadline).toBeLessThan(STALLED_AFTER_MS);
  });

  it('says it did not answer when the deadline passes, so the job retries with a reason', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(
      AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError')),
    );

    await expect(provider.send(email)).rejects.toThrow(/Postmark send did not answer in 90s/);
  });

  /** The status line arrives; the body is still coming when the deadline passes. */
  function stallBody(status: number) {
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
              );
            },
          }),
          { status },
        ),
    );
  }

  /**
   * The deadline governs the body too. Passing it after Postmark's 200 threw
   * from `response.json()`, and the job sent the customer a second copy of an
   * email Postmark had already accepted.
   */
  it('reports a send Postmark accepted as sent, rather than sending it again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stallBody(200);

    await expect(provider.send(email)).resolves.toEqual({
      providerMessageId: null,
      rfcMessageId: null,
      accepted: true,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/accepted with 200/));
  });

  it('still fails a refusal whose reason never arrived, naming the status', async () => {
    stallBody(422);

    await expect(provider.send(email)).rejects.toThrow(
      'Postmark send failed (422), and its reason never arrived in 90s',
    );
  });

  it('keeps an accepted send whose body is not the JSON it expected', async () => {
    stubFetch(async () => new Response('OK', { status: 200 }));

    await expect(provider.send(email)).resolves.toMatchObject({
      providerMessageId: null,
      accepted: true,
    });
  });
});
