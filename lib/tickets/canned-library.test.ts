import { describe, expect, it } from 'vitest';
import { CANNED_LIBRARY, librarySeedKey } from './canned-library';
import { preferredLocale } from './locale';

/**
 * The starter library's writing rules, as checks rather than as a paragraph.
 *
 * Each rule is here because the failure it prevents reaches a customer and is
 * invisible from the console: a canned response is inserted verbatim, an
 * automation sends one without anybody reading it, and the same text goes out
 * on five channels with different limits.
 */

const entries = CANNED_LIBRARY.flatMap((folder) =>
  folder.responses.map((response) => ({ folder: folder.name, ...response })),
);

const bodies = entries.flatMap((entry) => [
  { key: entry.key, locale: 'ar' as const, text: entry.ar },
  { key: entry.key, locale: 'en' as const, text: entry.en },
]);

describe('the canned-response library', () => {
  it('has stable, unique keys, each one a seed key nothing else uses', () => {
    const keys = entries.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z]+\.[a-z_]+$/);
    expect(librarySeedKey('delivery.late')).toBe('library:delivery.late');
  });

  // The picker lists titles grouped by folder; two rows with one title are two
  // rows an agent cannot tell apart, and a long one is cut off on a phone.
  it('gives every response a distinct, short title and every folder a distinct name', () => {
    const titles = entries.map((entry) => entry.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const title of titles) expect(title.length).toBeLessThanOrEqual(60);

    const folders = CANNED_LIBRARY.map((folder) => folder.name);
    expect(new Set(folders).size).toBe(folders.length);
    for (const folder of CANNED_LIBRARY) expect(folder.responses.length).toBeGreaterThan(0);
  });

  it.each(bodies)('$key ($locale) is written and trimmed', ({ text }) => {
    expect(text.trim()).toBe(text);
    expect(text.length).toBeGreaterThan(0);
  });

  // Instagram refuses a direct message over 1000 characters, and it is the
  // strictest of the five channels the same text is sent on. A longer body
  // would insert fine and fail only once it reached Graph.
  it.each(bodies)('$key ($locale) fits an Instagram message', ({ text }) => {
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  // Nothing fills a blank in: the composer inserts the text as it is, and an
  // automation sends it unread. A placeholder is a bracket a customer receives.
  it.each(bodies)('$key ($locale) has no blank left to fill in', ({ text }) => {
    expect(text).not.toMatch(/[[\]{}<>]|_{2,}|\bX{2,}\b|\.{3}|…/);
  });

  // `support.shipblu.com` still serves the Freshdesk help centre, so a link
  // written into the library would point at the old one — and a link that
  // moves cannot be fixed by editing a row nobody knows is stale. Agents add
  // links through the knowledge panel, which builds them from the live host.
  // The customer is already talking to support, so no address or number either.
  it.each(bodies)('$key ($locale) carries no link, address or phone number', ({ text }) => {
    expect(text).not.toMatch(/https?:|www\.|\.com\b|@/i);
    expect(text).not.toMatch(/\d[\d\s-]{7,}\d/);
  });

  // Plain text on every channel: WhatsApp would bold an asterisk and email
  // would print it.
  it.each(bodies)('$key ($locale) is plain text', ({ text }) => {
    expect(text).not.toMatch(/[*_`#]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  // Each side reads as its own language to the detector the automation engine
  // picks a language with, so a pair pasted into the wrong fields is caught.
  it.each(entries)('$key is Arabic on one side and English on the other', ({ ar, en }) => {
    expect(preferredLocale('en', ar)).toBe('ar');
    expect(preferredLocale('en', en)).toBe('en');
    expect(en).not.toMatch(/[؀-ۿ]/);
  });

  // We never know the customer's gender, and the agent's is unknown to the
  // text too. «حضرتك» is the form that serves both; these are the forms that
  // give one away. Imperatives are gendered in writing, so instructions are
  // phrased «يمكن لحضرتك…» / «يُرجى…» instead.
  it.each(entries)('$key addresses the customer without assuming a gender', ({ ar }) => {
    const GENDERED = new Set([
      'عزيزي',
      'عزيزتي',
      'اضغط',
      'اضغطي',
      'قم',
      'قومي',
      'تفضل',
      'تفضلي',
      'اختر',
      'اختاري',
      'انتظر',
      'انتظري',
      'سعيد',
      'سعيدة',
      'متأكد',
      'متأكدة',
    ]);
    const words = ar.split(/[\s،؛؟.,:!()«»"\-–—/]+/u).filter(Boolean);
    expect(words.filter((word) => GENDERED.has(word))).toEqual([]);
  });

  it.each(entries)('$key avoids the formulas modern support writing dropped', ({ en }) => {
    expect(en).not.toMatch(
      /\b(kindly|dear|revert|valued customer|be (informed|advised)|rest assured|earliest convenience|do the needful)\b/i,
    );
    expect((en.match(/!/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  // An acknowledgement goes out unattended on every new conversation, at any
  // hour. A time or a count in it is a promise somebody will one day break
  // without knowing the automation still makes it.
  it('keeps the automatic acknowledgements free of any time or number', () => {
    const acknowledgements = entries.filter((entry) => entry.key.startsWith('ack.'));
    expect(acknowledgements.length).toBeGreaterThan(0);
    for (const entry of acknowledgements) {
      expect(entry.ar).not.toMatch(/[0-9٠-٩]/);
      expect(entry.en).not.toMatch(/[0-9]/);
    }
  });
});
