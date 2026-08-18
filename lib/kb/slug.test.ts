import { describe, expect, it } from 'vitest';
import { decodeSlugParam, freshdeskArticleId, slugify, uniqueSlug } from './slug';

describe('slugify', () => {
  it('handles ordinary English titles', () => {
    expect(slugify('How to track a shipment')).toBe('how-to-track-a-shipment');
    expect(slugify('  Spaces   everywhere  ')).toBe('spaces-everywhere');
  });

  it('keeps Arabic instead of erasing it', () => {
    // The whole reason this is not a one-line regex: an ASCII-only slugify
    // returns '' here, and every Arabic article collides on the same URL.
    expect(slugify('كيف أتتبع شحنتي')).toBe('كيف-أتتبع-شحنتي');
  });

  it('strips tashkeel so two spellings of one word share a URL', () => {
    expect(slugify('شَحْنَة')).toBe(slugify('شحنة'));
  });

  it('removes characters that are URL syntax', () => {
    expect(slugify('What is a "COD" order? (FAQ)')).toBe('what-is-a-cod-order-faq');
    expect(slugify('a/b#c?d')).toBe('a-b-c-d');
  });

  it('removes zero-width and bidi-override characters', () => {
    // These render as nothing, so two slugs differing only by one look
    // identical to a human and are a tidy way to spoof an article URL.
    expect(slugify(`track${'​'}shipment`)).toBe('track-shipment');
    expect(slugify(`safe${'‮'}txt`)).toBe('safe-txt');
    expect(slugify(`a${'‍'}b`)).toBe('a-b');
  });

  it('collapses and trims hyphens', () => {
    expect(slugify('a  --  b')).toBe('a-b');
    expect(slugify('---edge---')).toBe('edge');
  });

  it('falls back when a title reduces to nothing', () => {
    expect(slugify('!!!', 'article')).toBe('article');
    expect(slugify('')).toBe('');
  });
});

describe('decodeSlugParam', () => {
  it('decodes an Arabic slug back to what slugify stored', () => {
    // The bug this exists for: Next hands the segment over still encoded, so
    // the query looked for the literal '%D8%B4...' and every Arabic page 404d.
    const slug = slugify('شركات الشحن');
    expect(decodeSlugParam(encodeURIComponent(slug))).toBe(slug);
  });

  it('leaves an already-decoded slug alone', () => {
    expect(decodeSlugParam('how-to-track-a-shipment')).toBe('how-to-track-a-shipment');
    expect(decodeSlugParam('شركات-الشحن')).toBe('شركات-الشحن');
  });

  it('passes malformed escapes through instead of throwing', () => {
    // A scanner asking for /a/%zz has to get a 404, not a 500.
    expect(decodeSlugParam('%zz')).toBe('%zz');
    expect(decodeSlugParam('%')).toBe('%');
    expect(decodeSlugParam('%D8')).toBe('%D8');
  });
});

describe('uniqueSlug', () => {
  it('returns the base when it is free', () => {
    expect(uniqueSlug('overview', ['other'])).toBe('overview');
  });

  it('suffixes past every taken variant', () => {
    expect(uniqueSlug('overview', ['overview'])).toBe('overview-2');
    expect(uniqueSlug('overview', ['overview', 'overview-2', 'overview-3'])).toBe('overview-4');
  });
});

describe('freshdeskArticleId', () => {
  it('pulls the numeric id out of a Freshdesk article URL', () => {
    expect(freshdeskArticleId('/support/solutions/articles/72000123456-how-to-track')).toBe(
      '72000123456',
    );
    expect(freshdeskArticleId('/solutions/articles/443322')).toBe('443322');
  });

  it('returns null for anything else', () => {
    expect(freshdeskArticleId('/support/tickets/123')).toBeNull();
    expect(freshdeskArticleId('')).toBeNull();
  });
});
