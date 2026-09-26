import { describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { plusAddressingEnabled, replyToAddress } from './reply-address';
import { parseReplyToken, parseSideReplyToken, extractTokenFromAddress } from './threading';

/**
 * The bounce these guard against is §6.41: a Reply-To carrying a plus token, on
 * a domain whose mail host forwards one bare address and rejects everything
 * else. The assertions are therefore about the *shape of the address we
 * advertise* rather than about threading, which `threading.test.ts` owns.
 */

const SECRET = '0'.repeat(64);
const FROM = 'help-support@shipblu.com';

withTestEnv({ APP_SECRET: SECRET, EMAIL_FROM_ADDRESS: FROM });

describe('replyToAddress', () => {
  it('advertises the from address, not a token, by default', () => {
    expect(replyToAddress({ kind: 'ticket', conversationNumber: 77 })).toBe(FROM);
    expect(replyToAddress({ kind: 'side', sideNumber: 3 })).toBe(FROM);
    expect(plusAddressingEnabled()).toBe(false);
  });

  it('falls back to the from address even when a reply domain is set', () => {
    // The trap this closes: `<mailbox>@<reply domain>` splices two independent
    // settings into an address nobody has confirmed exists. The from address is
    // the one we just proved deliverable by sending from it.
    setTestEnv({ EMAIL_REPLY_DOMAIN: 'reply.shipblu.com' });

    expect(replyToAddress({ kind: 'side', sideNumber: 3 })).toBe(FROM);
  });

  it('carries a signed token once a deployment opts in', () => {
    setTestEnv({ EMAIL_REPLY_PLUS_ADDRESSING: 'true' });

    const ticket = replyToAddress({ kind: 'ticket', conversationNumber: 77 });
    const side = replyToAddress({ kind: 'side', sideNumber: 3 });

    expect(ticket).toMatch(/^help-support\+c77\.[0-9a-f]{16}@shipblu\.com$/);
    expect(side).toMatch(/^help-support\+s3\.[0-9a-f]{16}@shipblu\.com$/);

    // And the tokens are the ones inbound will actually recognise.
    expect(parseReplyToken(extractTokenFromAddress(ticket)!, SECRET)).toBe(77);
    expect(parseSideReplyToken(extractTokenFromAddress(side)!, SECRET)).toBe(3);
  });

  it('builds the opted-in token on the reply domain when one is set', () => {
    setTestEnv({ EMAIL_REPLY_PLUS_ADDRESSING: 'true', EMAIL_REPLY_DOMAIN: 'reply.shipblu.com' });

    expect(replyToAddress({ kind: 'side', sideNumber: 3 })).toMatch(
      /^help-support\+s3\.[0-9a-f]{16}@reply\.shipblu\.com$/,
    );
  });

  it('treats anything but "true" as off, so a typo cannot silently bounce mail', () => {
    for (const value of ['false', '1', 'yes', 'TRUE', '']) {
      setTestEnv({ EMAIL_REPLY_PLUS_ADDRESSING: value });
      expect(replyToAddress({ kind: 'side', sideNumber: 3 })).toBe(FROM);
    }
  });

  it('refuses to invent a sender when the from address is missing', () => {
    setTestEnv({ EMAIL_FROM_ADDRESS: undefined });

    expect(() => replyToAddress({ kind: 'ticket', conversationNumber: 1 })).toThrow(
      /EMAIL_FROM_ADDRESS/,
    );
  });
});
