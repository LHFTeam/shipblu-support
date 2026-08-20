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
  it('finds one in an English sentence', () => {
    expect(detectShipmentRefs('Where is SB123456789 please?', P).trackingNumbers).toEqual([
      'SB123456789',
    ]);
  });

  it('finds one in an Arabic sentence', () => {
    const text = 'رقم الشحنة SB123456789 لو سمحت';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual(['SB123456789']);
  });

  it('finds one written in Arabic-Indic digits', () => {
    const text = 'الشحنة SB١٢٣٤٥٦٧٨٩ لسه ما وصلتش';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual(['SB123456789']);
  });

  it('normalises before deduplicating, so two spellings are one number', () => {
    const text = 'SB123456789 and also sb-123456789 again';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual(['SB123456789']);
  });

  it('keeps several distinct numbers in the order they were written', () => {
    const text = 'SB222222222 then SB111111111';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual(['SB222222222', 'SB111111111']);
  });

  it('does not treat a ticket reference as a tracking number', () => {
    expect(detectShipmentRefs('see #812 and #SB123456789', P).trackingNumbers).toEqual([]);
  });

  it('does not treat an Egyptian mobile number as a tracking number', () => {
    for (const phone of ['01014428154', '201014428154', '+20 101 442 8154', '0101-442-8154']) {
      const custom = defaultPatterns({ tracking: /\b[\d\s\-+]{10,16}\b/g });
      expect(detectShipmentRefs(phone, custom).trackingNumbers).toEqual([]);
    }
  });

  it('applies the phone guard to a custom digits-only pattern too', () => {
    // The regression that will bite when the real format lands as bare digits.
    const custom = defaultPatterns({ tracking: /\b\d{10,13}\b/g });
    expect(detectShipmentRefs('call 201014428154', custom).trackingNumbers).toEqual([]);
    expect(detectShipmentRefs('parcel 7788990011', custom).trackingNumbers).toEqual(['7788990011']);
  });

  it('does not match inside an email address or a longer token', () => {
    expect(detectShipmentRefs('orders@SB123456789.com', P).trackingNumbers).toEqual([]);
    expect(detectShipmentRefs('SB123456789X is not one', P).trackingNumbers).toEqual([]);
  });

  it('does match inside a tracking URL, which is how customers paste them', () => {
    const text = 'https://shipblu.com/track/SB123456789';
    expect(detectShipmentRefs(text, P).trackingNumbers).toEqual(['SB123456789']);
  });

  it('caps how many one message can produce', () => {
    const many = Array.from({ length: 200 }, (_, i) => `SB${String(i).padStart(9, '0')}`).join(' ');
    expect(detectShipmentRefs(many, P).trackingNumbers).toHaveLength(P.maxPerMessage);
  });

  it('drops anything on the ignore list', () => {
    const patterns = defaultPatterns({ ignore: new Set(['SB123456789']) });
    expect(detectShipmentRefs('example SB123456789', patterns).trackingNumbers).toEqual([]);
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
    const found = detectShipmentRefs('SB123456789', P);
    expect(found.trackingNumbers).toEqual(['SB123456789']);
    expect(found.sbids).toEqual([]);
  });

  it('finds both when a message carries both', () => {
    const found = detectShipmentRefs('Account SBID 4471, shipment SB123456789', P);
    expect(found.sbids).toEqual(['4471']);
    expect(found.trackingNumbers).toEqual(['SB123456789']);
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
