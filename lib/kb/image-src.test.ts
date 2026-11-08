import { describe, expect, it } from 'vitest';
import { htmlToText, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { normaliseArticleHtml } from './format';
import {
  fetchableFreshworksImage,
  imageSources,
  isFreshworksImage,
  kbImageIdOf,
  kbImageSrc,
  rewriteImageSources,
} from './image-src';

/** The shape every one of production's 214 images had on 2026-11-07. */
const FRESHDESK =
  'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/154012345678/original/step-1.png?1738062536';
const ID = '0b7c6f0e-6a55-4d4f-9a52-0f1f4c3a2b10';

/** What the write path stores for some HTML: the pair every writer runs. */
const stored = (html: string) => normaliseArticleHtml(sanitiseArticleHtml(html));

describe('imageSources', () => {
  it('reads every src from stored HTML, in order', () => {
    const html = stored(
      `<p>Open the dashboard.</p><p><img src="${FRESHDESK}" /></p>` +
        '<p>Then <img src="/api/kb/images/x" alt="the button" /> this.</p>',
    );
    expect(imageSources(html)).toEqual([FRESHDESK, '/api/kb/images/x']);
  });

  it('decodes the entities the sanitiser writes into an attribute', () => {
    // A query string with two parameters is stored with `&amp;`; the address
    // fetched, and the key the copy is found by, is the decoded one.
    const html = stored('<p><img src="https://cdn.freshdesk.com/a.png?x=1&y=2" /></p>');
    expect(html).toContain('x=1&amp;y=2');
    expect(imageSources(html)).toEqual(['https://cdn.freshdesk.com/a.png?x=1&y=2']);
  });

  it('ignores an image with no src and anything that is not an image', () => {
    expect(
      imageSources('<p><img alt="nothing" /> <a href="https://x.freshdesk.com/">x</a></p>'),
    ).toEqual([]);
  });
});

describe('rewriteImageSources', () => {
  it('changes the src and no other character', () => {
    const html = stored(
      `<h2>Step one</h2><p><img src="${FRESHDESK}" alt="Step one" /></p><p>Done.</p>`,
    );
    const { html: next, replaced } = rewriteImageSources(html, (src) =>
      src === FRESHDESK ? kbImageSrc(ID) : undefined,
    );

    expect(replaced).toBe(1);
    expect(next).toBe(html.replace(FRESHDESK, `/api/kb/images/${ID}`));
  });

  it('leaves alone every src the caller does not answer for', () => {
    const html = stored(`<p><img src="${FRESHDESK}" /><img src="https://example.com/b.png" /></p>`);
    const { html: next, replaced } = rewriteImageSources(html, () => undefined);
    expect(replaced).toBe(0);
    expect(next).toBe(html);
  });

  it('rewrites the same address everywhere it appears', () => {
    // Seven of production's addresses are in two articles each, and one
    // screenshot can be shown twice in one article.
    const html = stored(`<p><img src="${FRESHDESK}" /></p><p><img src="${FRESHDESK}" /></p>`);
    const { replaced } = rewriteImageSources(html, () => kbImageSrc(ID));
    expect(replaced).toBe(2);
  });

  it('stores nothing the write path would change, in either direction', () => {
    // The job writes the body straight to the row, not through `articleBody`,
    // so its output has to be a body the console's next Save keeps as it is:
    // otherwise the first edit after the run rewrites more than the editor
    // typed. The same holds for the way back, whose address carries a query.
    const html = stored(
      `<p>Before</p><p><img src="${FRESHDESK}" loading="lazy" /></p>` +
        '<p><img src="https://cdn.freshdesk.com/a.png?x=1&y=2" /></p>',
    );
    const forward = rewriteImageSources(html, () => kbImageSrc(ID)).html;
    expect(stored(forward)).toBe(forward);

    const back = rewriteImageSources(forward, () => 'https://cdn.freshdesk.com/a.png?x=1&y=2').html;
    expect(stored(back)).toBe(back);
    expect(imageSources(back)).toEqual([
      'https://cdn.freshdesk.com/a.png?x=1&y=2',
      'https://cdn.freshdesk.com/a.png?x=1&y=2',
    ]);
  });

  it('does not move the text search reads', () => {
    // `body_text` is derived with images skipped, which is why the job writes
    // only `body_html`; if that ever changed, the job would owe the text too.
    const html = stored(`<p>Press <img src="${FRESHDESK}" alt="Save" /> to finish.</p>`);
    const next = rewriteImageSources(html, () => kbImageSrc(ID)).html;
    expect(htmlToText(next)).toBe(htmlToText(html));
  });
});

describe('kbImageIdOf', () => {
  it('reads the id back out of our own src, and nothing else', () => {
    expect(kbImageIdOf(kbImageSrc(ID))).toBe(ID);
    expect(kbImageIdOf(kbImageSrc(ID.toUpperCase()))).toBe(ID);
    expect(kbImageIdOf('/api/kb/images/not-a-uuid')).toBeNull();
    expect(kbImageIdOf(`https://elsewhere.example/api/kb/images/${ID}`)).toBeNull();
    expect(kbImageIdOf(`/api/kb/images/${ID}/x`)).toBeNull();
  });
});

describe('isFreshworksImage', () => {
  it('matches what the audit query counts', () => {
    expect(isFreshworksImage(FRESHDESK)).toBe(true);
    expect(isFreshworksImage('https://fwusercontent.com/x.png')).toBe(true);
    expect(isFreshworksImage(kbImageSrc(ID))).toBe(false);
    expect(isFreshworksImage('https://example.com/x.png')).toBe(false);
  });
});

describe('fetchableFreshworksImage', () => {
  it("accepts Freshdesk's bucket, addressed both ways S3 allows", () => {
    expect(fetchableFreshworksImage(FRESHDESK)).toBe(true);
    expect(
      fetchableFreshworksImage('https://s3.us-east-1.amazonaws.com/cdn.freshdesk.com/data/a.png'),
    ).toBe(true);
    expect(fetchableFreshworksImage('https://cdn.freshdesk.com.s3.amazonaws.com/data/a.png')).toBe(
      true,
    );
  });

  it("accepts Freshworks' own domains and their subdomains", () => {
    expect(fetchableFreshworksImage('https://shipblu.freshdesk.com/helpdesk/attachments/1')).toBe(
      true,
    );
    expect(fetchableFreshworksImage('https://attachment.freshworks.com/a.png')).toBe(true);
  });

  it('refuses another bucket on S3, even one the audit pattern matches', () => {
    // The audit's pattern would match this; downloading it would be fetching
    // whatever somebody else's bucket holds.
    expect(fetchableFreshworksImage('https://s3.amazonaws.com/not-freshdesk/a.png')).toBe(false);
    expect(fetchableFreshworksImage('https://s3.amazonaws.com/bucket/freshdesk/a.png')).toBe(false);
    expect(isFreshworksImage('https://s3.amazonaws.com/bucket/freshdesk/a.png')).toBe(true);
  });

  it('refuses a host that only contains a Freshworks name', () => {
    expect(fetchableFreshworksImage('https://freshdesk.com.example.net/a.png')).toBe(false);
    expect(fetchableFreshworksImage('https://notfreshdesk.com/a.png')).toBe(false);
  });

  it('refuses anything but HTTPS, credentials in the URL and what does not parse', () => {
    expect(fetchableFreshworksImage(FRESHDESK.replace('https:', 'http:'))).toBe(false);
    expect(fetchableFreshworksImage('https://user:pass@cdn.freshdesk.com/a.png')).toBe(false);
    expect(fetchableFreshworksImage('/relative/a.png')).toBe(false);
    expect(fetchableFreshworksImage('')).toBe(false);
  });
});
