import { describe, expect, it } from 'vitest';
import { normaliseEmail, normaliseIdentifier, normalisePhone } from './normalise';

describe('normaliseEmail', () => {
  it('lowercases and trims', () => {
    expect(normaliseEmail('  Ali@ShipBlu.COM ')).toBe('ali@shipblu.com');
  });
});

describe('normalisePhone', () => {
  it('strips formatting to bare digits', () => {
    expect(normalisePhone('+20 100 123 4567')).toBe('201001234567');
    expect(normalisePhone('+20-100-123-4567')).toBe('201001234567');
    expect(normalisePhone('(20) 1001234567')).toBe('201001234567');
  });

  it('produces the same value however the number was written', () => {
    // This is what stops one customer becoming two contacts.
    const variants = ['+201001234567', '00201001234567'.replace(/^00/, ''), '20 100 123 4567'];
    const normalised = new Set(variants.map(normalisePhone));
    expect(normalised.size).toBe(1);
  });
});

describe('normaliseIdentifier', () => {
  it('applies email rules to the email channel', () => {
    expect(normaliseIdentifier('email', ' Foo@Bar.com')).toBe('foo@bar.com');
  });

  it('applies phone rules to whatsapp', () => {
    expect(normaliseIdentifier('whatsapp', '+20 100 123 4567')).toBe('201001234567');
  });

  it('preserves case for opaque social ids', () => {
    // Facebook PSIDs and Instagram IGSIDs are case-sensitive opaque tokens;
    // lowercasing them would break contact matching.
    expect(normaliseIdentifier('instagram', ' AbC123XyZ ')).toBe('AbC123XyZ');
  });
});
