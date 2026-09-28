import { describe, expect, it, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { describeIncomingWebhook, logIncomingWebhook, shouldLogIncomingWebhooks } from './log';

function delivery(overrides: Partial<Parameters<typeof describeIncomingWebhook>[0]> = {}) {
  return {
    source: 'meta',
    method: 'POST',
    url: 'https://shipblu-support.onrender.com/api/webhooks/meta?x=1',
    headers: new Headers({ 'content-type': 'application/json' }),
    rawBody: '{"object":"instagram"}',
    ...overrides,
  };
}

withTestEnv();

describe('shouldLogIncomingWebhooks', () => {
  it('is off unless the flag is exactly "true"', () => {
    setTestEnv({ LOG_ALL_INCOMING_WEBHOOKS: undefined });
    expect(shouldLogIncomingWebhooks()).toBe(false);

    // A half-set flag must not turn this on: it prints customer content, so
    // "1", "TRUE" and "yes" are all off rather than helpfully coerced.
    for (const value of ['false', '1', 'TRUE', 'yes', '']) {
      setTestEnv({ LOG_ALL_INCOMING_WEBHOOKS: value });
      expect(shouldLogIncomingWebhooks()).toBe(false);
    }

    setTestEnv({ LOG_ALL_INCOMING_WEBHOOKS: 'true' });
    expect(shouldLogIncomingWebhooks()).toBe(true);
  });

  it('prints nothing while off, whatever it is handed', () => {
    setTestEnv({ LOG_ALL_INCOMING_WEBHOOKS: undefined });

    const print = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logIncomingWebhook(delivery());
      expect(print).not.toHaveBeenCalled();
    } finally {
      print.mockRestore();
    }
  });
});

describe('describeIncomingWebhook', () => {
  it('redacts credential headers and keeps the signature', () => {
    // Postmark authenticates with Basic Auth, so this is the real case: the
    // inbound email endpoint receives EMAIL_WEBHOOK_SECRET on every delivery.
    const output = describeIncomingWebhook(
      delivery({
        headers: new Headers({
          authorization: 'Basic c2hpcGJsdTpzdXBlci1zZWNyZXQ=',
          cookie: 'session=abc123',
          'x-api-key': 'k-live-9999',
          'x-hub-signature-256': 'sha256=deadbeef',
          'user-agent': 'facebookexternalua',
        }),
      }),
    ).join('\n');

    expect(output).not.toContain('c2hpcGJsdTpzdXBlci1zZWNyZXQ=');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('k-live-9999');
    expect(output).toContain('authorization=[redacted]');
    expect(output).toContain('cookie=[redacted]');
    expect(output).toContain('x-api-key=[redacted]');

    // The signature is evidence, not a credential, and a mismatch is one of the
    // failures this tool exists to show.
    expect(output).toContain('x-hub-signature-256=sha256=deadbeef');
    expect(output).toContain('user-agent=facebookexternalua');
  });

  it('prints the path and the body, not the server origin', () => {
    const output = describeIncomingWebhook(delivery()).join('\n');

    // §6.24: request.url names the address the server is bound to, not the one
    // the client used, so printing it whole invites the same misreading.
    expect(output).not.toContain('onrender.com');
    expect(output).toContain('meta POST /api/webhooks/meta?x=1');
    expect(output).toContain('{"object":"instagram"}');
  });

  it('keeps every header on one line, whatever the header count', () => {
    /*
      Render splits an app log on newlines, so a line per header meant ~20 log
      entries per delivery on the busiest inbound path in the system — and on
      Linux a write to a stdout pipe is synchronous, so that volume is paid on
      the event loop.
    */
    const many = new Headers();
    for (let i = 0; i < 25; i += 1) many.set(`x-custom-${i}`, String(i));

    const lines = describeIncomingWebhook(delivery({ headers: many }));

    // One summary line, one header line, one body line. Never one per header.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('x-custom-0=0');
    expect(lines[1]).toContain('x-custom-24=24');
  });

  it('truncates a long body and says how much it dropped', () => {
    const body = 'x'.repeat(9000);
    const output = describeIncomingWebhook(delivery({ rawBody: body })).join('\n');

    expect(output).toContain('9000b');
    expect(output).toContain('… 1000 more bytes');
    expect(output).not.toContain('x'.repeat(8001));
  });

  it('says so rather than printing a blank line for an empty body', () => {
    const output = describeIncomingWebhook(delivery({ rawBody: '' })).join('\n');
    expect(output).toContain('0b');
    expect(output).toContain('(empty)');
  });
});
