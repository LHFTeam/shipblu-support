import { describe, expect, it } from 'vitest';
import { messageKey, ownNumber } from './keys';

describe('messageKey', () => {
  it('reads our side and theirs, on a phone chat and an @lid one', () => {
    expect(messageKey('false_201154311931@c.us_3EB0CEF41CAFAF5654CA3B')).toBe(
      'in:3EB0CEF41CAFAF5654CA3B',
    );
    expect(messageKey('true_98801629040701@lid_FC1446B0791EAEBE190A4F4CAC258481')).toBe(
      'out:FC1446B0791EAEBE190A4F4CAC258481',
    );
  });

  it('matches the shape wamidKey gives the same message stored as a wamid', () => {
    // `wamidKey` of a production wamid on the coexistence number decodes to
    // `out:A53676B0D78F3438EA4632B061B8BCD5`; WhatsApp Web keys a phone-sent
    // message with the same 32 hex characters.
    expect(messageKey('true_201316114606444@c.us_A53676B0D78F3438EA4632B061B8BCD5')).toBe(
      'out:A53676B0D78F3438EA4632B061B8BCD5',
    );
  });

  it('drops a group message’s sender part', () => {
    expect(messageKey('false_120363001234567890@g.us_3EB0AB12_201000000000@c.us')).toBe(
      'in:3EB0AB12',
    );
  });

  it('answers null for anything that is not a message key', () => {
    expect(messageKey('')).toBeNull();
    expect(messageKey('3EB0CEF41CAFAF5654CA3B')).toBeNull();
    expect(messageKey('maybe_201154311931@c.us_3EB0')).toBeNull();
    expect(messageKey('true_201154311931_3EB0')).toBeNull();
  });
});

describe('ownNumber', () => {
  it('reads the number off the stored id, quoted or not, with or without a device', () => {
    expect(ownNumber('"201234567890:12@c.us"')).toBe('201234567890');
    expect(ownNumber('201234567890@c.us')).toBe('201234567890');
    expect(ownNumber('"201234567890:3@s.whatsapp.net"')).toBe('201234567890');
  });

  it('answers null rather than guessing', () => {
    expect(ownNumber(null)).toBeNull();
    expect(ownNumber('')).toBeNull();
    expect(ownNumber('"98801629040701@lid"')).toBeNull();
    expect(ownNumber('{"user":"201234567890"}')).toBeNull();
  });
});
