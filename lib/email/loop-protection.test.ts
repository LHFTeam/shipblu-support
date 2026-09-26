import { describe, expect, it } from 'vitest';
import { classifyAutomation, isSelfAddressed } from './loop-protection';
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
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('classifyAutomation', () => {
  it('treats an ordinary customer email as human', () => {
    const v = classifyAutomation(email());
    expect(v).toEqual({
      isAutomated: false,
      isBounce: false,
      isAutoReply: false,
      shouldAutoReply: true,
      reason: null,
    });
  });

  it('detects an out-of-office via Auto-Submitted', () => {
    // The canonical loop: our autoresponder answers this, it answers back.
    const v = classifyAutomation(email({ headers: { 'auto-submitted': 'auto-replied' } }));
    expect(v.isAutomated).toBe(true);
    expect(v.shouldAutoReply).toBe(false);
    expect(v.reason).toBe('auto_submitted:auto-replied');
  });

  it('honours Auto-Submitted: no as an explicit human marker', () => {
    const v = classifyAutomation(email({ headers: { 'auto-submitted': 'no' } }));
    expect(v.isAutomated).toBe(false);
    expect(v.shouldAutoReply).toBe(true);
  });

  it('detects a bounce from a null return-path', () => {
    const v = classifyAutomation(email({ headers: { 'return-path': '<>' } }));
    expect(v.isBounce).toBe(true);
    expect(v.shouldAutoReply).toBe(false);
    expect(v.reason).toBe('null_return_path');
  });

  it('detects a delivery status report by content type', () => {
    const v = classifyAutomation(
      email({
        headers: { 'content-type': 'multipart/report; report-type=delivery-status; boundary=x' },
      }),
    );
    expect(v.isBounce).toBe(true);
  });

  it('detects mailer-daemon as a bounce', () => {
    const v = classifyAutomation(email({ from: { address: 'MAILER-DAEMON@mx.example.com' } }));
    expect(v.isBounce).toBe(true);
    expect(v.reason).toBe('daemon_sender');
  });

  it('detects mailing lists', () => {
    expect(
      classifyAutomation(email({ headers: { 'list-id': '<x.list.example>' } })).isAutomated,
    ).toBe(true);
    expect(
      classifyAutomation(email({ headers: { 'list-unsubscribe': '<mailto:u@x>' } })).isAutomated,
    ).toBe(true);
  });

  it('detects bulk precedence but not ordinary precedence values', () => {
    expect(classifyAutomation(email({ headers: { precedence: 'bulk' } })).isAutomated).toBe(true);
    expect(classifyAutomation(email({ headers: { precedence: 'normal' } })).isAutomated).toBe(
      false,
    );
  });

  it('suppresses auto-reply for no-reply senders without calling them bounces', () => {
    // A human may sit behind notifications@; we just must not answer it.
    const v = classifyAutomation(email({ from: { address: 'no-reply@vendor.com' } }));
    expect(v.isAutomated).toBe(true);
    expect(v.isBounce).toBe(false);
    expect(v.shouldAutoReply).toBe(false);
  });

  it('is case-insensitive about header values', () => {
    expect(
      classifyAutomation(email({ headers: { 'auto-submitted': 'AUTO-GENERATED' } })).isAutomated,
    ).toBe(true);
    expect(classifyAutomation(email({ headers: { precedence: 'BULK' } })).isAutomated).toBe(true);
  });

  it('never sets shouldAutoReply when automated or bounced', () => {
    const cases: Partial<ParsedInboundEmail>[] = [
      { headers: { 'auto-submitted': 'auto-generated' } },
      { headers: { 'return-path': '<>' } },
      { headers: { 'list-id': '<l>' } },
      { headers: { precedence: 'junk' } },
      { from: { address: 'postmaster@x.com' } },
    ];
    for (const c of cases) {
      expect(classifyAutomation(email(c)).shouldAutoReply).toBe(false);
    }
  });
});

describe('classifyAutomation: isAutoReply', () => {
  // Ingest keeps an auto-reply from reopening a ticket or joining the queue, so
  // a wrong yes hides a real customer. Only the signals that mean "an
  // autoresponder wrote this" count.
  it.each([
    ['Auto-Submitted: auto-replied', { 'auto-submitted': 'auto-replied' }],
    ['Auto-Submitted in capitals', { 'auto-submitted': ' Auto-Replied ' }],
    ['X-Autoreply', { 'x-autoreply': 'yes' }],
    ['X-Autorespond', { 'x-autorespond': '1' }],
    ['Precedence: auto_reply', { precedence: 'auto_reply' }],
    // The chain stops at auto-generated; the vendor header beside it still counts.
    [
      'X-Autoreply behind Auto-Submitted: auto-generated',
      {
        'auto-submitted': 'auto-generated',
        'x-autoreply': 'yes',
      },
    ],
  ])('is an auto-reply on %s', (_label, headers) => {
    const v = classifyAutomation(email({ headers }));
    expect(v.isAutoReply).toBe(true);
    expect(v.isAutomated).toBe(true);
  });

  // Each of these is automated — our autoresponder stays quiet — but none says
  // an autoresponder wrote the mail, and a person can be behind every one.
  it.each([
    ['Auto-Submitted: auto-generated', email({ headers: { 'auto-submitted': 'auto-generated' } })],
    ['X-Auto-Response-Suppress', email({ headers: { 'x-auto-response-suppress': 'All' } })],
    ['Precedence: bulk', email({ headers: { precedence: 'bulk' } })],
    ['a mailing list', email({ headers: { 'list-id': '<x.list.example>' } })],
    ['a no-reply sender', email({ from: { address: 'no-reply@vendor.com' } })],
  ])('is automated but not an auto-reply on %s', (_label, mail) => {
    const v = classifyAutomation(mail);
    expect(v.isAutomated).toBe(true);
    expect(v.isAutoReply).toBe(false);
  });

  // The chain ignores an empty vendor header, so the flag must too. Otherwise the
  // mail is an auto-reply that still allows our acknowledgement: ingest keeps it
  // from reopening a resolved ticket, and the acknowledgement then answers it.
  it.each([['X-Autoreply'], ['X-Autorespond']])(
    'ignores an empty %s, as the chain does',
    (name) => {
      const v = classifyAutomation(email({ headers: { [name.toLowerCase()]: '' } }));
      expect(v).toMatchObject({ isAutomated: false, isAutoReply: false, shouldAutoReply: true });
    },
  );

  it('is not an auto-reply on Auto-Submitted: no, or on an ordinary email', () => {
    expect(classifyAutomation(email({ headers: { 'auto-submitted': 'no' } })).isAutoReply).toBe(
      false,
    );
    expect(classifyAutomation(email()).isAutoReply).toBe(false);
  });

  // A bounce is the automated mail an agent does need to see, so it keeps its
  // own handling even when it also carries an autoresponder header.
  it('never calls a bounce an auto-reply', () => {
    const v = classifyAutomation(
      email({ headers: { 'return-path': '<>', 'auto-submitted': 'auto-replied' } }),
    );
    expect(v.isBounce).toBe(true);
    expect(v.isAutoReply).toBe(false);
  });
});

describe('isSelfAddressed', () => {
  it('detects our own address, ignoring plus suffixes', () => {
    // A misconfigured forward can make the helpdesk email itself in a loop.
    expect(
      isSelfAddressed(email({ from: { address: 'support@shipblu.com' } }), ['support@shipblu.com']),
    ).toBe(true);
    expect(
      isSelfAddressed(email({ from: { address: 'support+c12.abc@shipblu.com' } }), [
        'support@shipblu.com',
      ]),
    ).toBe(true);
  });

  it('does not flag a genuine customer', () => {
    expect(isSelfAddressed(email(), ['support@shipblu.com'])).toBe(false);
  });
});
