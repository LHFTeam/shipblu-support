import { describe, expect, it } from 'vitest';
import { preferredLocale } from './locale';

/**
 * Which language an unattended message goes out in.
 *
 * The impure half of the module — the query that reads the contact and their
 * last message — is not covered here: vitest runs without a database. What is
 * worth testing is the decision, and it is the same one two automated senders
 * make about a real customer.
 */

describe('preferredLocale', () => {
  it('honours a contact who has been marked Arabic', () => {
    expect(preferredLocale('ar', 'where is my parcel')).toBe('ar');
  });

  // Every contact in production sits at the column default, which means nobody
  // has said rather than "reads English". Taking it literally answers an
  // Arabic-speaking customer base in English.
  it('reads the language off the message when the contact is at the default', () => {
    expect(preferredLocale('en', 'الشحنة لسه ما وصلتش')).toBe('ar');
    expect(preferredLocale('en', 'my parcel has not arrived')).toBe('en');
  });

  it('is not thrown by a tracking number inside an Arabic message', () => {
    expect(preferredLocale('en', 'SB123456 فين شحنتي؟')).toBe('ar');
  });

  it('is not thrown by an Arabic place name inside an English message', () => {
    expect(preferredLocale('en', 'Please deliver my order to شبرا tomorrow')).toBe('en');
  });

  it('falls back to English when there is nothing to read', () => {
    expect(preferredLocale('en', null)).toBe('en');
    expect(preferredLocale('en', '   ')).toBe('en');
  });
});
