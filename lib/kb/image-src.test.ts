import { describe, expect, it } from 'vitest';
import { htmlToText, sanitiseArticleHtml } from '@/lib/html/sanitize';
import { normaliseArticleHtml } from './format';
import {
  blockBoundaryAfter,
  fetchableFreshworksImage,
  imageSources,
  insertBlock,
  isFreshworksImage,
  KB_IMAGE_MAX_BYTES,
  kbImageIdOf,
  kbImageSrc,
  labelRulesOut,
  pictureParagraph,
  pictureSizeRefusal,
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
    // On the refusal's host list too, so it must be copied, or Save refuses it
    // and nothing ever moves it here.
    expect(isFreshworksImage('https://attachment.freshservice.com/x.png')).toBe(true);
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

  it('accepts the bucket virtual-hosted in a region, and refuses a look-alike bucket', () => {
    expect(
      fetchableFreshworksImage('https://cdn.freshdesk.com.s3.us-east-1.amazonaws.com/data/a.png'),
    ).toBe(true);
    expect(
      fetchableFreshworksImage('https://cdn.freshdesk.com.s3-us-west-2.amazonaws.com/data/a.png'),
    ).toBe(true);
    // A bucket name can contain dots: this is somebody's bucket called
    // `cdn.freshdesk.com.s3.evil`, and it starts the way Freshdesk's does.
    expect(
      fetchableFreshworksImage('https://cdn.freshdesk.com.s3.evil.s3.amazonaws.com/data/a.png'),
    ).toBe(false);
    expect(
      fetchableFreshworksImage('https://cdn.freshdesk.com.s3.amazonaws.com.evil.net/a.png'),
    ).toBe(false);
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

const src = kbImageSrc('0b5f8c1e-2a4b-4c3d-9e8f-1a2b3c4d5e6f');

describe('pictureParagraph and insertBlock', () => {
  it('puts an uploaded picture in a paragraph of its own, which the write path keeps', () => {
    expect(pictureParagraph(src)).toBe(`<p><img src="${src}" alt="" /></p>`);
    // Saved as written, but for the `loading` the sanitiser adds to every picture.
    expect(normaliseArticleHtml(sanitiseArticleHtml(pictureParagraph(src)))).toBe(
      `<p><img src="${src}" alt="" loading="lazy" /></p>`,
    );
  });

  it('inserts on lines of its own, and puts the caret after it', () => {
    const text = '<p>One</p><p>Two</p>';
    const at = '<p>One</p>'.length;

    expect(insertBlock(text, at, '<p>X</p>')).toEqual({
      text: '<p>One</p>\n<p>X</p>\n<p>Two</p>',
      caret: '<p>One</p>\n<p>X</p>\n'.length,
    });
  });

  it('adds no blank line where one is already, and writes into an empty body or at the end', () => {
    expect(insertBlock('a\n\nb', 2, 'X').text).toBe('a\nX\nb');
    expect(insertBlock('', 0, 'X')).toEqual({ text: 'X', caret: 1 });
    expect(insertBlock('a', 1, 'X')).toEqual({ text: 'a\nX', caret: 3 });
  });
});

describe('blockBoundaryAfter', () => {
  const body = '<p>Open the settings page</p>\n<ul><li>One <a href="/x">link</a></li></ul>';
  const afterParagraph = '<p>Open the settings page</p>'.length;

  it('moves a caret in the middle of a paragraph to its end', () => {
    expect(blockBoundaryAfter(body, '<p>Open the'.length)).toBe(afterParagraph);
  });

  it('moves a caret inside a tag, or deep in a list, out of the whole top-level block', () => {
    expect(blockBoundaryAfter(body, 2)).toBe(afterParagraph);
    const insideHref = body.indexOf('href') + 2;
    expect(blockBoundaryAfter(body, insideHref)).toBe(body.length);
  });

  it('leaves a caret between top-level blocks where it is', () => {
    expect(blockBoundaryAfter(body, afterParagraph)).toBe(afterParagraph);
    expect(blockBoundaryAfter(body, afterParagraph + 1)).toBe(afterParagraph + 1);
    expect(blockBoundaryAfter(body, 0)).toBe(0);
    expect(blockBoundaryAfter(body, body.length)).toBe(body.length);
  });

  it('reads a void tag as opening nothing, and sends a draft never closed to its end', () => {
    expect(blockBoundaryAfter('<p>a<br>b</p>tail', 4)).toBe('<p>a<br>b</p>'.length);
    expect(blockBoundaryAfter('<p>half written', 5)).toBe('<p>half written'.length);
  });

  // Text outside any element is one run to the browser, so a block in the
  // middle of it splits a sentence.
  it('moves a caret in text outside any element to the end of that text', () => {
    const loose = '<p>a</p>\nplease see the screenshot below\n<p>b</p>';
    expect(blockBoundaryAfter(loose, loose.indexOf(' the screenshot'))).toBe(
      loose.indexOf('\n<p>b'),
    );
    const plain = 'just some words typed';
    expect(blockBoundaryAfter(plain, 4)).toBe(plain.length);
    expect(blockBoundaryAfter('<p>a</p>tail', '<p>a</p>ta'.length)).toBe('<p>a</p>tail'.length);
  });

  it('puts an uploaded picture after the paragraph the caret was in, not inside it', () => {
    const at = blockBoundaryAfter(body, '<p>Open the'.length);
    expect(insertBlock(body, at, pictureParagraph(src)).text).toBe(
      `<p>Open the settings page</p>\n${pictureParagraph(src)}\n<ul><li>One <a href="/x">link</a></li></ul>`,
    );
  });
});

describe('pictureSizeRefusal and labelRulesOut', () => {
  it('refuses an empty file and one a byte over the limit, saying so without rounding', () => {
    expect(pictureSizeRefusal(0)).toBe('That file is empty. Choose a picture to upload.');
    expect(pictureSizeRefusal(KB_IMAGE_MAX_BYTES)).toBeNull();
    expect(pictureSizeRefusal(KB_IMAGE_MAX_BYTES + 1)).toBe(
      'That picture is over 10 MB, the most a picture can be.',
    );
  });

  it('rules out only a label that names something else, leaving the bytes to the server', () => {
    expect(labelRulesOut('application/pdf')).toBe(true);
    expect(labelRulesOut('text/plain')).toBe(true);
    expect(labelRulesOut('')).toBe(false);
    expect(labelRulesOut('image/jpg')).toBe(false);
    expect(labelRulesOut('image/png')).toBe(false);
  });
});
