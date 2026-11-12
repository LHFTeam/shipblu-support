import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  isEmailAddress,
  looksLikeEmail,
  normaliseEmail,
  normaliseIdentifier,
  normalisePhone,
} from './normalise';

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

describe('looksLikeEmail', () => {
  it('accepts an ordinary address', () => {
    expect(looksLikeEmail('cairo.hub@shipblu.com')).toBe(true);
    expect(looksLikeEmail(' Alex@ShipBlu.com ')).toBe(true);
  });

  it('rejects what would never be delivered', () => {
    expect(looksLikeEmail('')).toBe(false);
    expect(looksLikeEmail('shipblu.com')).toBe(false);
    expect(looksLikeEmail('hub@')).toBe(false);
    expect(looksLikeEmail('@shipblu.com')).toBe(false);
    // No dot in the domain: a bare hostname is not an address anyone can reach
    // from outside our network.
    expect(looksLikeEmail('hub@localhost')).toBe(false);
    expect(looksLikeEmail('two@@shipblu.com')).toBe(false);
    expect(looksLikeEmail('cairo hub@shipblu.com')).toBe(false);
  });

  // The checks this one replaced, kept to show which forms let each address
  // through: the help centre's registration asked the first regex, the side
  // conversations the second, every other form the third. `z.email()`, which
  // the job asked, refused every address in the first list but the last three
  // — a label ending in a hyphen and the two lengths — so those are where the
  // new rule is stricter than both old sides, not where they disagreed
  // (§6.117).
  const RETIRED_REGISTRATION_CHECK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const RETIRED_SIDE_CONVERSATION_CHECK = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
  const RETIRED_FORM_CHECK = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

  // What Postmark refuses, or DNS cannot route, and the forms let through.
  const LET_THROUGH = [
    // The shape of the registration whose link died on 2026-11-12: a Gmail
    // address with two dots in a row before the @.
    'amira..hassan@gmail.com',
    '.amira@gmail.com',
    'amira.@gmail.com',
    // `?` is RFC 5322's and not in Postmark's published set.
    'amira?@gmail.com',
    'amira@gmail.c0m',
    'amira@gmail.c',
    'amira@mail_box.com',
    'amira@-gmail.com',
    'amira@[192.0.2.1]',
    // Arabic letters before the @: Postmark's class is ASCII, and nothing here
    // sends SMTPUTF8. After it they are a domain, made ASCII (below).
    'أميرة@gmail.com',
    // `z.email()` took these three as well: a label ending in a hyphen, and
    // RFC 5321's limits, 64 before the @ and 254 in all.
    'amira@gmail-.com',
    `${'a'.repeat(65)}@gmail.com`,
    `amira@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`,
  ];

  it.each(LET_THROUGH)('refuses %s, which registration accepted', (address) => {
    expect(RETIRED_REGISTRATION_CHECK.test(normaliseEmail(address))).toBe(true);
    expect(looksLikeEmail(address)).toBe(false);
  });

  it('is where registration and the job disagreed, but for the last three', () => {
    // The job's old check, asked of the list: what it refused and registration
    // accepted is the disagreement that killed a link.
    const oldJob = (address: string) => z.email().safeParse(normaliseEmail(address)).success;
    expect(LET_THROUGH.slice(0, -3).filter(oldJob)).toEqual([]);
    expect(LET_THROUGH.slice(-3).every(oldJob)).toBe(true);
  });

  it('refuses the same addresses wherever else a form let them through', () => {
    const elsewhere = LET_THROUGH.filter(
      (address) =>
        RETIRED_FORM_CHECK.test(normaliseEmail(address)) ||
        RETIRED_SIDE_CONVERSATION_CHECK.test(normaliseEmail(address)),
    );
    expect(elsewhere).toContain('amira..hassan@gmail.com');
    expect(elsewhere.filter(looksLikeEmail)).toEqual([]);
  });

  it('refuses what no form let through either', () => {
    expect(looksLikeEmail('amira,hassan@gmail.com')).toBe(false);
    expect(looksLikeEmail('amira;hassan@gmail.com')).toBe(false);
    expect(looksLikeEmail('"amira hassan"@gmail.com')).toBe(false);
    expect(looksLikeEmail('amira@gmail..com')).toBe(false);
    expect(looksLikeEmail('amira@gmail.com.')).toBe(false);
    expect(looksLikeEmail('amira@shipblu.com\nbcc@evil.test')).toBe(false);
  });

  it('accepts what mailboxes hand out, the punctuation they allow included', () => {
    expect(looksLikeEmail('amira.hassan@gmail.com')).toBe(true);
    expect(looksLikeEmail('amira.hassan+orders@gmail.com')).toBe(true);
    expect(looksLikeEmail("o'brien@example.co.uk")).toBe(true);
    expect(looksLikeEmail('cairo_hub-2@mail.shipblu.com')).toBe(true);
    expect(looksLikeEmail('1755021358719@shipblu.com')).toBe(true);
    expect(looksLikeEmail('amira@xn--mgbh0fb.xn--wgbh1c')).toBe(true);
    expect(looksLikeEmail(`${'a'.repeat(64)}@gmail.com`)).toBe(true);
  });

  // `z.email()`, which the job asked, is Gmail's username rules and refused
  // these; Postmark lists every one of their characters and sends to them, and
  // a business address — a hub's forwarding list, a merchant's billing box —
  // can carry one.
  it.each([
    'sales&billing@merchant.example',
    'hub#3@shipblu.com',
    "amira'@gmail.com",
    'orders/cairo@merchant.example',
    'a!b$c%d*e=f^g`h{i|j}k~l@merchant.example',
  ])('accepts %s, which the job used to refuse and the provider takes', (address) => {
    expect(looksLikeEmail(address)).toBe(true);
  });

  it('drops the bidi and zero-width marks an address copied out of an RTL chat carries', () => {
    // `trim()` keeps them: they are format characters, not whitespace.
    expect(normaliseEmail('amira.hassan@gmail.com\u200F')).toBe('amira.hassan@gmail.com');
    expect(normaliseEmail('\u200E Amira@Gmail.com')).toBe('amira@gmail.com');
    expect(normaliseEmail('ami\u200Bra@gmail.com')).toBe('amira@gmail.com');
    expect(looksLikeEmail('amira.hassan@gmail.com\u200F')).toBe(true);
  });

  it('writes a domain in another script in its ASCII form, which is what can be sent to', () => {
    expect(normaliseEmail('Nour@مثال.مصر')).toBe('nour@xn--mgbh0fb.xn--wgbh1c');
    expect(normaliseEmail('amira@münchen.de')).toBe('amira@xn--mnchen-3ya.de');
    expect(normaliseEmail('amira@ｇｍａｉｌ.com')).toBe('amira@gmail.com');
    expect(looksLikeEmail('nour@مثال.مصر')).toBe(true);
    // The raw string is not what the job is handed; the normalised one is.
    expect(isEmailAddress('nour@مثال.مصر')).toBe(false);
    expect(isEmailAddress(normaliseEmail('nour@مثال.مصر'))).toBe(true);
  });

  it('hands the URL parser only a bare host name, so nothing after one is dropped', () => {
    // Read as a URL, `/x` would end the host and vanish, and the address pass.
    expect(normaliseEmail('amira@مثال.مصر/x')).toBe('amira@مثال.مصر/x');
    expect(looksLikeEmail('amira@مثال.مصر/x')).toBe(false);
    expect(looksLikeEmail('amira@مثال مصر')).toBe(false);
    expect(looksLikeEmail('a@b@مثال.مصر')).toBe(false);
  });

  it('asks nothing of case, the xn-- prefix included', () => {
    // `isEmailAddress` is asked of strings nobody lowercased: a sender in the
    // environment, a payload a person wrote.
    expect(isEmailAddress('Support@ShipBlu.COM')).toBe(true);
    expect(isEmailAddress('support@shipblu.XN--WGBH1C')).toBe(true);
  });

  it('asks the question of the address as a form stores it', () => {
    // A form trims and lowercases before it stores or queues anything, so the
    // check does too; the address it accepts is the one the job is handed.
    expect(looksLikeEmail('  Amira.Hassan@GMAIL.com ')).toBe(true);
    expect(isEmailAddress(normaliseEmail('  Amira.Hassan@GMAIL.com '))).toBe(true);
    expect(isEmailAddress('  amira.hassan@gmail.com ')).toBe(false);
  });
});
