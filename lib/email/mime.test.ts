import { describe, expect, it } from 'vitest';
import { buildRawMessage, encodeHeaderValue, formatAddress } from './mime';
import type { OutboundEmail } from './types';

function base(overrides: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    to: [{ address: 'nour@example.com' }],
    from: { address: 'support@shipblu.com', name: 'ShipBlu Support' },
    replyTo: 'support+c42.abc123@shipblu.com',
    subject: 'Re: Where is my shipment? [#42.abc123]',
    textBody: 'It is out for delivery.',
    htmlBody: '<p>It is out for delivery.</p>',
    messageId: 'a1b2c3@shipblu.com',
    ...overrides,
  };
}

function headersOf(raw: Buffer): string {
  return raw.toString('utf8').split('\r\n\r\n')[0]!;
}

describe('buildRawMessage', () => {
  it('sets the threading headers SES cannot', () => {
    const headers = headersOf(
      buildRawMessage(
        base({ inReplyTo: 'customer-msg@mail.example.com', references: ['first@shipblu.com'] }),
      ),
    );

    expect(headers).toContain('Message-ID: <a1b2c3@shipblu.com>');
    expect(headers).toContain('In-Reply-To: <customer-msg@mail.example.com>');
    expect(headers).toContain('<first@shipblu.com>');
    expect(headers).toContain('Reply-To: support+c42.abc123@shipblu.com');
  });

  it('uses CRLF line endings throughout', () => {
    const raw = buildRawMessage(base()).toString('utf8');
    // A bare LF anywhere makes the message invalid to strict SMTP receivers.
    expect(/[^\r]\n/.test(raw)).toBe(false);
  });

  it('sends multipart/alternative when there are no attachments', () => {
    const headers = headersOf(buildRawMessage(base()));
    expect(headers).toContain('Content-Type: multipart/alternative;');
    expect(headers).not.toContain('multipart/mixed');
  });

  it('wraps in multipart/mixed when there are attachments', () => {
    const raw = buildRawMessage(
      base({
        attachments: [
          { filename: 'awb.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') },
        ],
      }),
    ).toString('utf8');

    expect(headersOf(Buffer.from(raw))).toContain('Content-Type: multipart/mixed;');
    expect(raw).toContain('Content-Disposition: attachment; filename="awb.pdf"');
    expect(raw).toContain(Buffer.from('%PDF-1.4').toString('base64'));
  });

  it('neutralises a filename that would break out of the header', () => {
    const raw = buildRawMessage(
      base({
        attachments: [
          {
            filename: 'evil".pdf\r\nX-Injected: yes',
            contentType: 'application/pdf',
            content: Buffer.from('x'),
          },
        ],
      }),
    ).toString('utf8');

    expect(raw).not.toContain('X-Injected: yes\r\n');
    expect(raw).toContain('filename="evil_.pdf__X-Injected: yes"');
  });

  it('strips newlines from a subject so headers cannot be injected', () => {
    const headers = headersOf(
      buildRawMessage(base({ subject: 'Hello\r\nBcc: attacker@example.com' })),
    );

    // The text survives inside the Subject, which is harmless; what matters is
    // that no line *begins* a Bcc header.
    expect(headers.split('\r\n').some((line) => line.startsWith('Bcc:'))).toBe(false);
    expect(headers).toContain('Subject: Hello Bcc: attacker@example.com');
  });

  it('base64-encodes both bodies', () => {
    const raw = buildRawMessage(base()).toString('utf8');
    expect(raw).toContain(Buffer.from('It is out for delivery.', 'utf8').toString('base64'));
    expect(raw).toContain(Buffer.from('<p>It is out for delivery.</p>', 'utf8').toString('base64'));
  });

  it('caps encoded lines at 76 characters', () => {
    const raw = buildRawMessage(base({ textBody: 'x'.repeat(5000) })).toString('utf8');
    const longest = Math.max(...raw.split('\r\n').map((line) => line.length));
    expect(longest).toBeLessThanOrEqual(78);
  });
});

describe('encodeHeaderValue', () => {
  it('leaves plain ASCII alone', () => {
    expect(encodeHeaderValue('Where is my shipment?')).toBe('Where is my shipment?');
  });

  it('RFC 2047 encodes Arabic, which would otherwise be mangled', () => {
    const encoded = encodeHeaderValue('أين شحنتي؟');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8')).toBe('أين شحنتي؟');
  });

  it('collapses embedded newlines', () => {
    expect(encodeHeaderValue('one\r\ntwo')).toBe('one two');
  });
});

describe('formatAddress', () => {
  it('emits a bare address when there is no name', () => {
    expect(formatAddress({ address: 'nour@example.com' })).toBe('nour@example.com');
  });

  it('quotes a display name containing a comma', () => {
    expect(formatAddress({ address: 'a@b.com', name: 'Support, ShipBlu' })).toBe(
      '"Support, ShipBlu" <a@b.com>',
    );
  });

  it('encodes a non-ASCII display name', () => {
    expect(formatAddress({ address: 'a@b.com', name: 'شيب بلو' })).toMatch(
      /^=\?UTF-8\?B\?.+\?= <a@b\.com>$/,
    );
  });
});
