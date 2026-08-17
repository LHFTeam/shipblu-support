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
