import { describe, expect, it } from 'vitest';
import { readEmailBody } from './body';
import type { ParsedInboundEmail } from './types';

function email(overrides: Partial<ParsedInboundEmail> = {}): ParsedInboundEmail {
  return {
    messageId: 'm1@example.com',
    references: [],
    from: { address: 'customer@example.com' },
    to: [{ address: 'support@shipblu.com' }],
    cc: [],
    subject: 'Where is my parcel?',
    textBody: 'hello',
    attachments: [],
    headers: {},
    dateHeader: null,
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('readEmailBody', () => {
  it('sanitises the HTML part on the way in', () => {
    // The repo's first non-negotiable: this must never reach storage, because
    // nothing downstream sanitises on read.
    const body = readEmailBody(
      email({ htmlBody: '<p>Still waiting</p><script>alert(1)</script>' }),
    );

    expect(body.bodyHtml).toContain('Still waiting');
    expect(body.bodyHtml).not.toContain('<script');
    expect(body.bodyHtml).not.toContain('alert(1)');
  });

  it('prefers the real text part over flattened HTML', () => {
    // A plain-text reply survives intact; htmlToText of the same mail would
    // introduce the HTML part's link markers and spacing.
    const body = readEmailBody(
      email({ textBody: 'Still waiting', htmlBody: '<p>Still <b>waiting</b></p>' }),
    );

    expect(body.bodyText).toBe('Still waiting');
  });

  it('falls back to the flattened HTML when there is no text part', () => {
    const body = readEmailBody(email({ textBody: '', htmlBody: '<p>HTML only</p>' }));

    expect(body.bodyText).toContain('HTML only');
  });

  it('is empty rather than null when the mail carried no body at all', () => {
    const body = readEmailBody(email({ textBody: '' }));

    expect(body.bodyHtml).toBeNull();
    expect(body.bodyText).toBe('');
    expect(body.rawBody).toBe('');
  });

  it('strips the quote but keeps the original in rawBody', () => {
    // rawBody is the only copy of what was removed, and what an agent reads
    // when a strip took too much.
    const textBody = [
      'It still has not arrived.',
      '',
      'On Mon, 17 Aug 2026 at 10:04, ShipBlu Support <support@shipblu.com> wrote:',
      '> Thanks for getting in touch.',
    ].join('\n');

    const body = readEmailBody(email({ textBody }));

    expect(body.bodyText.trim()).toBe('It still has not arrived.');
    expect(body.rawBody).toContain('Thanks for getting in touch.');
    expect(body.strippedBy).toBe('on_wrote');
  });

  it('keeps the HTML part as rawBody when the mail had one', () => {
    const body = readEmailBody(email({ htmlBody: '<p>Sent from my phone</p>' }));

    expect(body.rawBody).toBe('<p>Sent from my phone</p>');
  });

  it('reports the text strip rule ahead of the HTML one', () => {
    // Both parts can match. The text rule is named first because bodyText is
    // what the console shows, so that is the rule an agent is debugging.
    const body = readEmailBody(
      email({
        textBody: 'Any update?\n\n-----Original Message-----\nFrom: support@shipblu.com',
        htmlBody: '<p>Any update?</p><blockquote>older</blockquote>',
      }),
    );

    expect(body.strippedBy).toBe('original_message');
  });
});
