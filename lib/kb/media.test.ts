import { describe, expect, it } from 'vitest';
import {
  buildKbMediaPath,
  isMirrorableMediaUrl,
  isStorableMediaType,
  mirrorableSources,
  rewriteArticleMedia,
} from './media';

/**
 * The allowlist is the only thing standing between "copy the article's pictures"
 * and "fetch whatever URL is in the article, from inside the private network".
 * These are the cases that decide it.
 */
describe('isMirrorableMediaUrl', () => {
  it('accepts a Freshdesk attachment on the bucket path it actually uses', () => {
    expect(
      isMirrorableMediaUrl(
        'https://s3.amazonaws.com/cdn.freshdesk.com/data/helpdesk/attachments/production/154049896279/original/NC6.png?1738063082',
      ),
    ).toBe(true);
  });

  it('refuses another bucket on the same host', () => {
    // The host alone would admit every bucket on S3, which is why the path
    // prefix is part of the rule rather than documentation.
    expect(isMirrorableMediaUrl('https://s3.amazonaws.com/some-other-bucket/secret.png')).toBe(
      false,
    );
  });

  it('refuses a host that merely contains an allowed one', () => {
    // The check is on the parsed hostname, so neither a subdomain trick nor a
    // path that looks like a host gets through.
    expect(isMirrorableMediaUrl('https://cdn.freshdesk.com.evil.test/x.png')).toBe(false);
    expect(isMirrorableMediaUrl('https://evil.test/cdn.freshdesk.com/x.png')).toBe(false);
  });

  it('refuses anything that is not https', () => {
    // Including the shapes an SSRF probe reaches for first.
    expect(isMirrorableMediaUrl('http://cdn.freshdesk.com/x.png')).toBe(false);
    expect(isMirrorableMediaUrl('file:///etc/passwd')).toBe(false);
    expect(isMirrorableMediaUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
  });

  it('refuses something that is not a URL at all', () => {
    expect(isMirrorableMediaUrl('')).toBe(false);
    expect(isMirrorableMediaUrl('/relative/path.png')).toBe(false);
  });
});

describe('isStorableMediaType', () => {
  it('accepts the image types Freshdesk serves', () => {
    expect(isStorableMediaType('image/png')).toBe(true);
    expect(isStorableMediaType('image/jpeg; charset=binary')).toBe(true);
    expect(isStorableMediaType('IMAGE/GIF')).toBe(true);
  });

  it('refuses SVG', () => {
    // An image to a browser and a script host to an attacker, and these are
    // served back under our own origin to customers.
    expect(isStorableMediaType('image/svg+xml')).toBe(false);
    expect(isStorableMediaType('text/html')).toBe(false);
  });
});

describe('buildKbMediaPath', () => {
  it('gives the same key to the same source URL', () => {
    // What makes the Arabic and English copies of one screenshot share an
    // object instead of writing the bytes twice.
    const url = 'https://cdn.freshdesk.com/data/a.png?1738063082';
    expect(buildKbMediaPath(url, 'image/png')).toBe(buildKbMediaPath(url, 'image/png'));
  });

  it('takes nothing from the URL but its hash', () => {
    // The last segment of a Freshdesk URL is a filename somebody else chose.
    const path = buildKbMediaPath(
      'https://cdn.freshdesk.com/data/../../etc/passwd.png',
      'image/png',
    );
    expect(path).toMatch(/^kb\/media\/[0-9a-f]{32}\.png$/);
    expect(path).not.toContain('..');
  });
});

describe('mirrorableSources', () => {
  it('finds the images worth copying and ignores the rest', () => {
    const html = [
      '<img src="https://s3.amazonaws.com/cdn.freshdesk.com/data/one.png" alt="">',
      '<img src="https://example.test/not-ours.png" alt="">',
      '<img src="/api/kb/media/already-done" alt="">',
    ].join('');

    expect(mirrorableSources(html)).toEqual([
      'https://s3.amazonaws.com/cdn.freshdesk.com/data/one.png',
    ]);
  });

  it('deduplicates a screenshot used twice in one article', () => {
    const src = 'https://cdn.freshdesk.com/data/one.png';
    expect(mirrorableSources(`<img src="${src}"><p>x</p><img src="${src}">`)).toHaveLength(1);
  });

  it('decodes the entities the sanitiser wrote into the attribute', () => {
    // `sanitize-html` re-encodes `&` on the way out and every Freshdesk URL
    // carries a query string, so the stored attribute is not the URL to fetch.
    // Keying the map on the raw attribute would miss all 214 of them.
    expect(
      mirrorableSources('<img src="https://cdn.freshdesk.com/a.png?v=1&amp;w=2" alt="">'),
    ).toEqual(['https://cdn.freshdesk.com/a.png?v=1&w=2']);
  });
});

describe('rewriteArticleMedia', () => {
  it('repoints an image at its stored copy', () => {
    const src = 'https://cdn.freshdesk.com/data/one.png';
    const html = `<p>before</p><img src="${src}" alt="A label">`;

    expect(rewriteArticleMedia(html, new Map([[src, '/api/kb/media/abc']]))).toBe(
      '<p>before</p><img src="/api/kb/media/abc" alt="A label">',
    );
  });

  it('matches an entity-encoded attribute against the decoded key', () => {
    const html = '<img src="https://cdn.freshdesk.com/a.png?v=1&amp;w=2">';
    const map = new Map([['https://cdn.freshdesk.com/a.png?v=1&w=2', '/api/kb/media/abc']]);

    expect(rewriteArticleMedia(html, map)).toBe('<img src="/api/kb/media/abc">');
  });

  it('leaves an image that has not been copied yet exactly as it was', () => {
    // A partially mirrored article still renders: what has been copied is
    // served from us, what has not still loads from where it always did.
    const html =
      '<img src="https://cdn.freshdesk.com/one.png"><img src="https://other.test/x.png">';

    expect(rewriteArticleMedia(html, new Map())).toBe(html);
    expect(
      rewriteArticleMedia(html, new Map([['https://cdn.freshdesk.com/one.png', '/m/1']])),
    ).toBe('<img src="/m/1"><img src="https://other.test/x.png">');
  });

  it('does not touch an href that happens to hold the same URL', () => {
    // Only `src` on an `img` is media. A link to the same file is a link.
    const html = '<a href="https://cdn.freshdesk.com/one.png">download</a>';
    expect(
      rewriteArticleMedia(html, new Map([['https://cdn.freshdesk.com/one.png', '/m/1']])),
    ).toBe(html);
  });
});
