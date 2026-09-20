import { describe, expect, it } from 'vitest';
import { redirectTo } from './redirect';

describe('redirectTo', () => {
  it('survives an Arabic slug, which a raw header value does not', () => {
    // The failure being prevented: a header value is a ByteString, so the raw
    // path throws `Cannot convert argument to a ByteString` and the route
    // answers 500 instead of redirecting. 58 of the 112 articles in production
    // have a non-ASCII slug, so this is the ordinary case for the KB.
    expect(() => new Headers({ Location: '/ar/a/الشحن-الدولي' })).toThrow();

    const response = redirectTo('/ar/a/الشحن-الدولي', 301);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe(
      '/ar/a/%D8%A7%D9%84%D8%B4%D8%AD%D9%86-%D8%A7%D9%84%D8%AF%D9%88%D9%84%D9%8A',
    );
  });

  it('leaves an ASCII path exactly as given', () => {
    expect(redirectTo('/login', 303).headers.get('Location')).toBe('/login');
    expect(redirectTo('/en/a/how-to-track-a-shipment', 301).headers.get('Location')).toBe(
      '/en/a/how-to-track-a-shipment',
    );
  });

  it('does not double-encode a path that already carries escapes', () => {
    // `kb_redirects.to_path` is typed by an admin and may arrive either way.
    // `encodeURI` would turn %D8 into %25D8 and send the reader to a 404.
    expect(redirectTo('/ar/a/%D8%A7-pre-encoded', 301).headers.get('Location')).toBe(
      '/ar/a/%D8%A7-pre-encoded',
    );
    expect(redirectTo('/login?next=%2Fkb', 303).headers.get('Location')).toBe('/login?next=%2Fkb');
  });

  it('is idempotent, so a caller that already encoded is not punished', () => {
    const once = redirectTo('/ar/a/الشحن', 301).headers.get('Location')!;
    expect(redirectTo(once, 301).headers.get('Location')).toBe(once);
  });

  it('keeps the Location relative', () => {
    // Absolute would reintroduce the internal listen address this module's
    // header comment is about.
    expect(redirectTo('/ar/a/الشحن', 301).headers.get('Location')).toMatch(/^\//);
  });
});
