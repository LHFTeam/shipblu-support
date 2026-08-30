import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRACKING_PATTERN,
  compilePattern,
  defaultPatterns,
  detectShipmentRefs,
} from './detect';
import { normaliseDigits, normaliseSbid, normaliseTrackingNumber } from './format';

const P = defaultPatterns();

describe('normaliseTrackingNumber', () => {
  it('uppercases and strips the separators people write in', () => {
    expect(normaliseTrackingNumber('sb 123-456-789')).toBe('SB123456789');
    expect(normaliseTrackingNumber('SB/123.456789')).toBe('SB123456789');
  });

  it('folds Arabic-Indic and Extended Arabic-Indic digits', () => {
    expect(normaliseTrackingNumber('SB١٢٣٤٥٦٧٨٩')).toBe('SB123456789');
    expect(normaliseDigits('۱۲۳')).toBe('123');
  });

  it('strips the bidi marks that come along with an RTL paste', () => {
    expect(normaliseTrackingNumber('‏SB123456789‎')).toBe('SB123456789');
    expect(normaliseTrackingNumber('SB123456789﻿')).toBe('SB123456789');
  });

  it('is idempotent', () => {
    for (const input of ['sb 123-456-789', '‏SB١٢٣٤٥٦٧٨٩', 'AWB-9988776655']) {
      const once = normaliseTrackingNumber(input);
      expect(normaliseTrackingNumber(once)).toBe(once);
    }
  });

  it('returns empty for input with nothing in it', () => {
    expect(normaliseTrackingNumber('   ')).toBe('');
    expect(normaliseTrackingNumber('---')).toBe('');
  });
});

describe('normaliseSbid', () => {
  it('collapses every way of writing one account onto a single value', () => {
    const forms = ['SBID-4471', 'sbid 4471', 'SB4471', '4471', 'sbid:4471'];
    const values = new Set(forms.map(normaliseSbid));
    expect(values).toEqual(new Set(['4471']));
  });
});

describe('detectShipmentRefs — tracking numbers', () => {
  // Every one of these is a real tracking number taken out of the production
  // archive, with the message it arrived in. They are the whole reason the
  // default pattern changed, so they are what the default pattern is tested on.
  it('finds the real format, bare, in the messages customers actually sent', () => {
    const archive: Array<[string, string]> = [
      ['1755021358719', '1755021358719'],
      ['1632778410963 ده رقم التتبع', '1632778410963'],
      ['1458167895137\nعايز اتتبعها', '1458167895137'],
      ['كنت عاوز اسال علي الشحنه دي \n1819327671284', '1819327671284'],
      ['السلام عليكم\nكنت عايز اعرف انت هستلم امتى\n1687122670992', '1687122670992'],
      ['*رقم التتبع*: 1260185528952\nإضغط 👇 للمتابعة', '1260185528952'],
    ];

    for (const [message, expected] of archive) {
      expect(detectShipmentRefs(message, P).trackingNumbers).toEqual([expected]);
    }
  });

  it('finds one in our own tracking link, which is how customers paste them', () => {
    const text = 'https://go.shipblu.com/en/1903828629327';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual(['1903828629327']);
  });

  it('finds one written with a hash, which a ticket number is far too short to be', () => {
    // Both of these are in the archive. The highest ticket number in production
    // is 13,747, so nothing this long is ever a `#` reference.
    expect(detectShipmentRefs('#1195223624566', P).trackingNumbers).toEqual(['1195223624566']);
    expect(detectShipmentRefs('#3164648397745', P).trackingNumbers).toEqual(['3164648397745']);
  });

  it('still leaves the ticket namespace to parseSearchTerm', () => {
    const custom = defaultPatterns({ tracking: /\b\d{3,}\b/g });
    expect(detectShipmentRefs('see #812', custom).trackingNumbers).toEqual([]);
    expect(detectShipmentRefs('see 812', custom).trackingNumbers).toEqual(['812']);
  });

  it('accepts the letters the shipping team says may appear', () => {
    for (const form of ['SB1755021358719', 'AWB-1755021358719', '1755021358719A']) {
      const found = detectShipmentRefs(`shipment ${form}`, P).trackingNumbers;
      expect(found).toEqual([normaliseTrackingNumber(form)]);
    }
  });

  it('does not match twelve digits, one short of the format', () => {
    expect(detectShipmentRefs('order 175502135871 please', P).trackingNumbers).toEqual([]);
  });

  it('finds one in an Arabic sentence written in Arabic-Indic digits', () => {
    const text = 'الشحنة ١٧٥٥٠٢١٣٥٨٧١٩ لسه ما وصلتش';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual(['1755021358719']);
  });

  it('normalises before deduplicating, so two spellings are one number', () => {
    const text = 'SB1755021358719 and also sb-1755021358719 again';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual(['SB1755021358719']);
  });

  it('keeps several distinct numbers in the order they were written', () => {
    const text = '1875520568576 then 1875530887108';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual(['1875520568576', '1875530887108']);
  });

  it('does not treat an Egyptian mobile number as a tracking number', () => {
    // The dialled-international form is fourteen digits, so unlike under the old
    // letters-and-digits default it now reaches the pattern and has to be caught.
    expect(detectShipmentRefs('call me on 00201014428154', P).trackingNumbers).toEqual([]);
  });

  it('keeps catching the shorter phone forms for a custom digits-only pattern', () => {
    const custom = defaultPatterns({ tracking: /\b\d{10,13}\b/g });
    for (const phone of ['01014428154', '201014428154', '0101-442-8154']) {
      expect(detectShipmentRefs(phone, custom).trackingNumbers).toEqual([]);
    }
    expect(detectShipmentRefs('parcel 7788990011', custom).trackingNumbers).toEqual(['7788990011']);
  });

  it('does not take a thirteen-digit number that merely starts 20 for a phone', () => {
    // An Egyptian mobile is ten national digits and no writing of one reaches
    // thirteen, so the guard must not swallow the format it is protecting.
    expect(detectShipmentRefs('2010144281540', P).trackingNumbers).toEqual(['2010144281540']);
  });

  it('does not match the fraction of a decimal', () => {
    // §6.17: the digits in this archive are overwhelmingly GPS coordinates.
    expect(detectShipmentRefs('pin at 31.200925031234567', P).trackingNumbers).toEqual([]);
    expect(detectShipmentRefs('30.044419600000001, 31.235711600000002', P).trackingNumbers).toEqual(
      [],
    );
  });

  it('does not match a query-string parameter', () => {
    // The one false positive in the whole archive, a spam link.
    const text = 'https://whwru.buzz/RiAMlvd/eg-ar?0829925610882845530&s=wa&t=1787985551&';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual([]);
  });

  it('does not write a payment card into the shipments table', () => {
    for (const card of ['4539578763621486', '378282246310005', '4035501000000008']) {
      expect(detectShipmentRefs(`my card is ${card}`, P).trackingNumbers).toEqual([]);
    }
  });

  it('leaves a card-length number that is not a card alone', () => {
    // The guard is Luhn plus a card length, so it cannot fire on the format.
    expect(detectShipmentRefs('4539578763621487', P).trackingNumbers).toEqual(['4539578763621487']);
  });

  it('does not absorb the word next to the number', () => {
    // `[A-Z]{1,4}[-\\s]?` would read `is` and `then` as part of these.
    expect(detectShipmentRefs('tracking is 1755021358719', P).trackingNumbers).toEqual([
      '1755021358719',
    ]);
    expect(detectShipmentRefs('1875520568576 then 1875530887108', P).trackingNumbers).toEqual([
      '1875520568576',
      '1875530887108',
    ]);
  });

  it('does not match inside an email address or a longer token', () => {
    expect(detectShipmentRefs('orders@1755021358719.com', P).trackingNumbers).toEqual([]);
    expect(detectShipmentRefs('PARCEL1755021358719', P).trackingNumbers).toEqual([]);
  });

  it('caps how many one message can produce', () => {
    const many = Array.from({ length: 200 }, (_, i) => `17550213587${String(i).padStart(2, '0')}`);
    expect(detectShipmentRefs(many.join(' '), P).trackingNumbers).toHaveLength(P.maxPerMessage);
  });

  it('drops anything on the ignore list', () => {
    const patterns = defaultPatterns({ ignore: new Set(['1755021358719']) });
    expect(detectShipmentRefs('example 1755021358719', patterns).trackingNumbers).toEqual([]);
  });

  it('finds nothing in an empty or number-free message', () => {
    expect(detectShipmentRefs('', P)).toEqual({ trackingNumbers: [], sbids: [] });
    expect(detectShipmentRefs('   ', P)).toEqual({ trackingNumbers: [], sbids: [] });
    expect(detectShipmentRefs('شكرا جزيلا', P).trackingNumbers).toEqual([]);
  });
});

describe('detectShipmentRefs — SBIDs', () => {
  it('matches the keyword-anchored forms', () => {
    for (const form of ['SBID 4471', 'SBID-4471', 'sbid:4471', 'SB4471', 'sb #4471']) {
      expect(detectShipmentRefs(`my account is ${form}`, P).sbids).toEqual(['4471']);
    }
  });

  it('does not match a bare number, which is a quantity far more often', () => {
    expect(detectShipmentRefs('I ordered 4471 units', P).sbids).toEqual([]);
  });

  it('does not claim a ticket reference', () => {
    expect(detectShipmentRefs('#4471', P).sbids).toEqual([]);
  });

  it('does not let a tracking number be read as an SBID as well', () => {
    // `SB` then thirteen digits cannot satisfy the SBID pattern's three-to-eight,
    // so the two no longer compete for the same token at all.
    const found = detectShipmentRefs('SB1755021358719', P);
    expect(found.trackingNumbers).toEqual(['SB1755021358719']);
    expect(found.sbids).toEqual([]);
  });

  it('finds both when a message carries both', () => {
    const found = detectShipmentRefs('Account SBID 4471, shipment 1755021358719', P);
    expect(found.sbids).toEqual(['4471']);
    expect(found.trackingNumbers).toEqual(['1755021358719']);
  });
});

describe('compilePattern', () => {
  it('falls back to the default rather than throwing on a bad pattern', () => {
    const compiled = compilePattern('([unclosed', DEFAULT_TRACKING_PATTERN, 'TEST_PATTERN');
    expect(compiled.source).toBe(DEFAULT_TRACKING_PATTERN);
  });

  it('uses a valid override as given', () => {
    const compiled = compilePattern('\\bXX\\d{3}\\b', DEFAULT_TRACKING_PATTERN, 'TEST_PATTERN');
    expect(compiled.source).toBe('\\bXX\\d{3}\\b');
  });
});
