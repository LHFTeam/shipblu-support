import { describe, expect, it } from 'vitest';
import { seedTerms } from './seed';

describe('seedTerms', () => {
  it('reads content words out of an Arabic message', () => {
    expect(seedTerms(null, 'ازاي اعمل طلب استلام للشحنة؟')).toEqual([
      'اعمل',
      'طلب',
      'استلام',
      'للشحنة',
    ]);
  });

  it('reads content words out of an English message', () => {
    expect(seedTerms(null, 'How do I create a pickup request for my order?')).toEqual([
      'create',
      'pickup',
      'request',
      'order',
    ]);
  });

  it('drops tracking numbers and every other token carrying a digit', () => {
    // The AWB is the most-repeated string in these messages and matches no
    // article, so letting it through would spend a slot to guarantee a miss.
    expect(seedTerms(null, 'my parcel SBL1234567 is late, ordered 12/03 on 24h delivery')).toEqual([
      'parcel',
      'late',
      'ordered',
      'delivery',
    ]);
  });

  it('caps the disjunction so a long message cannot widen it indefinitely', () => {
    const paragraph =
      'I placed an order last Sunday afternoon and the courier attempted delivery ' +
      'twice without calling me first, then the application changed the status to ' +
      'returned although nobody ever reached my address in Maadi.';

    expect(seedTerms(null, paragraph)).toHaveLength(6);
  });

  it('treats tashkeel as decoration rather than as a different word', () => {
    // Same word, written with and without diacritics — one term, not two.
    expect(seedTerms(null, 'الشِّحنة الشحنة وصلت')).toEqual(['الشحنة', 'وصلت']);
  });

  it('falls back to the subject when the message is a pleasantry', () => {
    expect(seedTerms('Refund not received for cancelled order', 'شكرا جدا')).toEqual([
      'refund',
      'received',
      'cancelled',
      'order',
    ]);
  });

  it('prefers the latest message over a stale chat subject', () => {
    // Chat tickets are named after their first message, which stops describing
    // them immediately.
    expect(seedTerms('السلام عليكم', 'الشحنة اتأخرت اسبوع')).toEqual(['الشحنة', 'اتأخرت', 'اسبوع']);
  });

  it('gives up rather than suggesting from a single word', () => {
    // One term matches most of the knowledge base, so a panel built on it is
    // three rows the agent has to read to discover they are noise.
    expect(seedTerms(null, 'شحنتي')).toEqual([]);
    expect(seedTerms(null, '👍')).toEqual([]);
    expect(seedTerms(null, '')).toEqual([]);
    expect(seedTerms(null, null)).toEqual([]);
  });

  it('gives up when a media-only message has no subject to fall back to', () => {
    expect(seedTerms(null, '   ')).toEqual([]);
  });
});
