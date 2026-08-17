import { describe, expect, it } from 'vitest';
import { PostmarkEmailProvider } from './postmark';

const provider = new PostmarkEmailProvider('token', 'webhook-secret-value');

function basicAuth(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`user:${password}`).toString('base64')}` };
}

describe('PostmarkEmailProvider.verifySignature', () => {
  it('accepts the configured secret', () => {
    expect(provider.verifySignature('{}', basicAuth('webhook-secret-value'))).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(provider.verifySignature('{}', basicAuth('wrong-secret-value'))).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(provider.verifySignature('{}', {})).toBe(false);
    expect(provider.verifySignature('{}', { authorization: 'Bearer abc' })).toBe(false);
  });

  it('rejects a secret of a different length without throwing', () => {
    // timingSafeEqual throws on length mismatch, so this must be guarded.
    expect(() => provider.verifySignature('{}', basicAuth('short'))).not.toThrow();
    expect(provider.verifySignature('{}', basicAuth('short'))).toBe(false);
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
