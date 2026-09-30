import { describe, expect, it } from 'vitest';
import {
  buildReferences,
  buildReplyAddress,
  buildReplySubject,
  buildReplyToken,
  buildSideReplyAddress,
  buildSideReplyToken,
  buildSideSubjectTag,
  buildSubjectTag,
  extractTokenFromAddress,
  formatAddress,
  normaliseMessageId,
  parseReplyToken,
  parseSideReplyToken,
  parseSideSubjectTag,
  parseSubjectTag,
  resolveThread,
  stripSubjectPrefixes,
} from './threading';
import type { ParsedInboundEmail } from './types';

const SECRET = 'test-secret-at-least-32-characters-long';

function email(overrides: Partial<ParsedInboundEmail> = {}): ParsedInboundEmail {
  return {
    messageId: 'inbound-1@example.com',
    references: [],
    from: { address: 'customer@example.com' },
    to: [{ address: 'support@shipblu.com' }],
    cc: [],
    subject: 'Where is my shipment?',
    textBody: 'hello',
    attachments: [],
    headers: {},
    dateHeader: null,
    receivedAt: new Date(),
    ...overrides,
  };
}

describe('reply tokens', () => {
  it('round-trips a conversation number', () => {
    const token = buildReplyToken(1234, SECRET);
    expect(parseReplyToken(token, SECRET)).toBe(1234);
  });

  it('rejects a forged signature', () => {
    // The whole point: a ticket number is a small guessable integer, so an
    // unsigned token would expose other customers' tickets.
    expect(parseReplyToken('c1234.aaaaaaaaaaaa', SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = buildReplyToken(1234, 'a-completely-different-secret-value');
    expect(parseReplyToken(token, SECRET)).toBeNull();
  });

  it('rejects a token whose number was tampered with', () => {
    const token = buildReplyToken(1234, SECRET);
    const tampered = token.replace('c1234', 'c1235');
    expect(parseReplyToken(tampered, SECRET)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(parseReplyToken('garbage', SECRET)).toBeNull();
    expect(parseReplyToken('c12', SECRET)).toBeNull();
    expect(parseReplyToken('', SECRET)).toBeNull();
  });

  it('extracts the token from a plus address, case-insensitively', () => {
    const address = buildReplyAddress(77, SECRET, 'support', 'shipblu.com');
    expect(address).toMatch(/^support\+c77\./);
    const token = extractTokenFromAddress(address.toUpperCase());
    expect(token).not.toBeNull();
    expect(parseReplyToken(token!, SECRET)).toBe(77);
  });

  it('returns null for an address with no plus part', () => {
    expect(extractTokenFromAddress('support@shipblu.com')).toBeNull();
  });
});

describe('subject tags', () => {
  it('round-trips', () => {
    const tag = buildSubjectTag(42, SECRET);
    expect(parseSubjectTag(`Re: broken parcel ${tag}`, SECRET)).toBe(42);
  });

  it('rejects an unsigned or forged tag', () => {
    expect(parseSubjectTag('Re: hello [#42]', SECRET)).toBeNull();
    expect(parseSubjectTag('Re: hello [#42.zzzzzzzzzzzz]', SECRET)).toBeNull();
  });
});

describe('stripSubjectPrefixes', () => {
  it('strips stacked prefixes across locales', () => {
    expect(stripSubjectPrefixes('Re: Fwd: RE: Where is my parcel?')).toBe('Where is my parcel?');
    expect(stripSubjectPrefixes('AW: SV: Anfrage')).toBe('Anfrage');
    expect(stripSubjectPrefixes('رد: أين شحنتي؟')).toBe('أين شحنتي؟');
  });

  it('strips Outlook numbered prefixes', () => {
    expect(stripSubjectPrefixes('Re[2]: Where is my parcel?')).toBe('Where is my parcel?');
  });

  it('leaves a clean subject alone', () => {
    expect(stripSubjectPrefixes('Where is my parcel?')).toBe('Where is my parcel?');
  });
});

describe('buildReplySubject', () => {
  it('does not stack Re: or duplicate the tag', () => {
    const first = buildReplySubject('Where is my parcel?', 9, SECRET);
    const second = buildReplySubject(first, 9, SECRET);

    expect(second.match(/Re:/g)).toHaveLength(1);
    expect(second.match(/\[#9\./g)).toHaveLength(1);
    expect(parseSubjectTag(second, SECRET)).toBe(9);
  });

  it('handles a missing subject', () => {
    expect(buildReplySubject(null, 3, SECRET)).toContain('(no subject)');
  });
});

describe('resolveThread', () => {
  it('prefers the reply token over everything else', () => {
    const result = resolveThread(
      email({
        to: [{ address: buildReplyAddress(500, SECRET, 'support', 'shipblu.com') }],
        inReplyTo: 'something@example.com',
        subject: `hi ${buildSubjectTag(999, SECRET)}`,
      }),
      SECRET,
    );
    expect(result).toEqual({ kind: 'reply_token', conversationNumber: 500 });
  });

  it('finds the token in Delivered-To when To is a bare address', () => {
    // Several providers rewrite To but preserve the envelope recipient.
    const result = resolveThread(
      email({
        to: [{ address: 'support@shipblu.com' }],
        deliveredTo: [buildReplyAddress(88, SECRET, 'support', 'shipblu.com')],
      }),
      SECRET,
    );
    expect(result).toEqual({ kind: 'reply_token', conversationNumber: 88 });
  });

  it('finds the token in Cc', () => {
    const result = resolveThread(
      email({ cc: [{ address: buildReplyAddress(11, SECRET, 'support', 'shipblu.com') }] }),
      SECRET,
    );
    expect(result).toEqual({ kind: 'reply_token', conversationNumber: 11 });
  });

  it('falls back to References, newest ancestor first', () => {
    // In-Reply-To is the direct parent so it leads; References is oldest →
    // newest in the header, so it is reversed behind it.
    const result = resolveThread(
      email({ references: ['oldest@x.com', 'middle@x.com'], inReplyTo: 'newest@x.com' }),
      SECRET,
    );
    expect(result).toEqual({
      kind: 'references',
      messageIds: ['newest@x.com', 'middle@x.com', 'oldest@x.com'],
    });
  });

  it('deduplicates ids shared between In-Reply-To and References', () => {
    const result = resolveThread(
      email({ references: ['a@x.com', 'b@x.com'], inReplyTo: 'b@x.com' }),
      SECRET,
    );
    expect(result.kind).toBe('references');
    if (result.kind === 'references') {
      expect(result.messageIds).toEqual(['b@x.com', 'a@x.com']);
    }
  });

  it('falls back to the subject tag when headers are stripped', () => {
    const result = resolveThread(
      email({ subject: `Re: parcel ${buildSubjectTag(31, SECRET)}` }),
      SECRET,
    );
    expect(result).toEqual({ kind: 'subject_tag', conversationNumber: 31 });
  });

  it('reports no match for a genuinely new email', () => {
    expect(resolveThread(email(), SECRET)).toEqual({ kind: 'none' });
  });

  it('ignores a forged reply token rather than hijacking a ticket', () => {
    const result = resolveThread(
      email({ to: [{ address: 'support+c500.forgedsigxxx@shipblu.com' }] }),
      SECRET,
    );
    expect(result).toEqual({ kind: 'none' });
  });
});

describe('header helpers', () => {
  it('normalises message ids with and without brackets', () => {
    expect(normaliseMessageId('<abc@host>')).toBe('abc@host');
    expect(normaliseMessageId('abc@host')).toBe('abc@host');
  });

  it('quotes and escapes display names', () => {
    expect(formatAddress({ address: 'a@b.com' })).toBe('a@b.com');
    expect(formatAddress({ address: 'a@b.com', name: 'Ali' })).toBe('"Ali" <a@b.com>');
    // A comma or quote in the name would otherwise split the header.
    expect(formatAddress({ address: 'a@b.com', name: 'Doe, Jane' })).toBe('"Doe, Jane" <a@b.com>');
    expect(formatAddress({ address: 'a@b.com', name: 'He "Q" Him' })).toBe(
      '"He \\"Q\\" Him" <a@b.com>',
    );
  });

  it('chains References as the parent, then our own id', () => {
    expect(buildReferences('parent@host', 'own@host')).toEqual(['parent@host', 'own@host']);
    // The first message of a thread has no parent, and its own id still goes in:
    // that is the belt against a provider rewriting the Message-ID header.
    expect(buildReferences(null, 'own@host')).toEqual(['own@host']);
    expect(buildReferences('own@host', 'own@host')).toEqual(['own@host']);
  });
});

describe('side conversation tokens', () => {
  it('round-trips a side conversation number', () => {
    const token = buildSideReplyToken(4, SECRET);
    expect(parseSideReplyToken(token, SECRET)).toBe(4);
  });

  it('rejects a forged signature', () => {
    expect(parseSideReplyToken('s4.aaaaaaaaaaaaaaaa', SECRET)).toBeNull();
  });

  it('rejects a tampered number', () => {
    const token = buildSideReplyToken(4, SECRET);
    expect(parseSideReplyToken(token.replace('s4', 's5'), SECRET)).toBeNull();
  });

  /**
   * The reason the signed input is `side:<n>` rather than `<n>`.
   *
   * Without domain separation the two tokens differ only in one leading
   * character of plain text, so a customer holding the reply address for their
   * own ticket #4 could edit `c` to `s` and reach internal thread #4 — where the
   * hub is discussing them. These four assertions are the whole guarantee.
   */
  it('does not accept a ticket signature for a side conversation, or the reverse', () => {
    const ticketToken = buildReplyToken(4, SECRET);
    const sideToken = buildSideReplyToken(4, SECRET);

    expect(sideToken).not.toBe(ticketToken.replace('c', 's'));
    expect(parseSideReplyToken(ticketToken.replace(/^c/, 's'), SECRET)).toBeNull();
    expect(parseReplyToken(sideToken.replace(/^s/, 'c'), SECRET)).toBeNull();

    // And neither parser is fooled by the other's well-formed token.
    expect(parseSideReplyToken(ticketToken, SECRET)).toBeNull();
    expect(parseReplyToken(sideToken, SECRET)).toBeNull();
  });

  it('builds an address inside the RFC 5321 local-part budget', () => {
    const address = buildSideReplyAddress(999999, SECRET, 'support', 'reply.shipblu.com');
    const localPart = address.split('@')[0] ?? '';
    expect(localPart.length).toBeLessThanOrEqual(64);
    expect(parseSideReplyToken(extractTokenFromAddress(address)!, SECRET)).toBe(999999);
  });

  it('round-trips a side subject tag without colliding with a ticket tag', () => {
    const tag = buildSideSubjectTag(4, SECRET);
    expect(parseSideSubjectTag(`Re: Late parcel ${tag}`, SECRET)).toBe(4);
    // A ticket parser must not read a side tag as a ticket number.
    expect(parseSubjectTag(`Re: Late parcel ${tag}`, SECRET)).toBeNull();
    // And a side parser must not read a ticket tag.
    expect(parseSideSubjectTag(`Re: Late parcel ${buildSubjectTag(4, SECRET)}`, SECRET)).toBeNull();
  });
});

describe('resolveThread — side conversations', () => {
  it('resolves a hub reply from the plus-addressed side token', () => {
    const match = resolveThread(
      email({
        to: [{ address: buildSideReplyAddress(7, SECRET, 'support', 'reply.shipblu.com') }],
        from: { address: 'ahmed@downtown-hub.shipblu.com' },
      }),
      SECRET,
    );

    expect(match).toEqual({ kind: 'side_reply_token', sideNumber: 7 });
  });

  it('finds the side token in Delivered-To when a forwarder rewrites To', () => {
    // The case a real forwarding list is most likely to produce.
    const match = resolveThread(
      email({
        to: [{ address: 'hub-downtown@shipblu.com' }],
        deliveredTo: [buildSideReplyAddress(7, SECRET, 'support', 'reply.shipblu.com')],
      }),
      SECRET,
    );

    expect(match).toEqual({ kind: 'side_reply_token', sideNumber: 7 });
  });

  it('prefers the side token over a ticket token on the same message', () => {
    // A mangled forward carrying both. Landing this on the ticket would put the
    // hub's answer where the customer portal can read it.
    const match = resolveThread(
      email({
        to: [{ address: buildReplyAddress(123, SECRET, 'support', 'reply.shipblu.com') }],
        cc: [{ address: buildSideReplyAddress(7, SECRET, 'support', 'reply.shipblu.com') }],
      }),
      SECRET,
    );

    expect(match).toEqual({ kind: 'side_reply_token', sideNumber: 7 });
  });

  it('falls back to the side subject tag when every address is stripped', () => {
    const match = resolveThread(
      email({
        to: [{ address: 'support@shipblu.com' }],
        subject: `Re: Late parcel [#123] ${buildSideSubjectTag(7, SECRET)}`,
      }),
      SECRET,
    );

    expect(match).toEqual({ kind: 'side_subject_tag', sideNumber: 7 });
  });

  it('still returns references first, so the caller can search both tables', () => {
    // References beats a subject tag for both kinds of thread; the caller
    // resolves the ids against side_conversation_messages before messages.
    const match = resolveThread(
      email({
        inReplyTo: 'sent-side-1@reply.shipblu.com',
        subject: `Re: Late parcel ${buildSideSubjectTag(7, SECRET)}`,
      }),
      SECRET,
    );

    expect(match).toEqual({
      kind: 'references',
      messageIds: ['sent-side-1@reply.shipblu.com'],
    });
  });
});
