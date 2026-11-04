import { beforeEach, describe, expect, it } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { fileLinkExpiry, fileLinkValid, widgetFileUrl } from './file-links';

/**
 * A widget's file link opens one file for a few hours and nothing else, and
 * stays the same string across the pushes of one window, so a thread's
 * pictures are not fetched again on every agent reply.
 */

withTestEnv();

const FILE = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const HOUR = 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);

function parts(url: string) {
  const parsed = new URL(url, 'https://support.example');
  return {
    id: decodeURIComponent(parsed.pathname.split('/').at(-1)!),
    expires: parsed.searchParams.get('expires'),
    signature: parsed.searchParams.get('signature'),
  };
}

describe('widgetFileUrl', () => {
  it('names the file and carries no session token', () => {
    const url = widgetFileUrl(FILE, at('2026-11-04T10:00:00Z'));
    expect(url.startsWith(`/api/widget/attachments/${FILE}?`)).toBe(true);
    expect(url).not.toMatch(/token/);
  });

  it('is the same string for every call inside one window', () => {
    expect(widgetFileUrl(FILE, at('2026-11-04T06:00:01Z'))).toBe(
      widgetFileUrl(FILE, at('2026-11-04T11:59:59Z')),
    );
    expect(widgetFileUrl(FILE, at('2026-11-04T12:00:00Z'))).not.toBe(
      widgetFileUrl(FILE, at('2026-11-04T11:59:59Z')),
    );
  });

  it('lasts between six and twelve hours from when it is signed', () => {
    for (const iso of ['2026-11-04T06:00:00Z', '2026-11-04T11:59:59Z']) {
      const now = at(iso);
      const left = fileLinkExpiry(now) * 1000 - now.getTime();
      expect(left).toBeGreaterThan(6 * HOUR);
      expect(left).toBeLessThanOrEqual(12 * HOUR);
    }
  });
});

describe('fileLinkValid', () => {
  const signedAt = at('2026-11-04T10:00:00Z');
  // Signed inside each test, under the environment `withTestEnv` gives it.
  let link: ReturnType<typeof parts>;
  beforeEach(() => {
    link = parts(widgetFileUrl(FILE, signedAt));
  });

  it('opens the file it was signed for until it expires', () => {
    expect(fileLinkValid(FILE, link.expires, link.signature, signedAt)).toBe(true);
    expect(
      fileLinkValid(FILE, link.expires, link.signature, new Date(signedAt.getTime() + 7 * HOUR)),
    ).toBe(true);
    expect(fileLinkValid(FILE, link.expires, link.signature, at('2026-11-05T00:00:00Z'))).toBe(
      false,
    );
  });

  it('opens no other file with the same signature', () => {
    expect(fileLinkValid(OTHER, link.expires, link.signature, signedAt)).toBe(false);
  });

  it('refuses an expiry moved later, which the signature covers', () => {
    const later = String(Number(link.expires) + 6 * 60 * 60);
    expect(fileLinkValid(FILE, later, link.signature, signedAt)).toBe(false);
  });

  it('refuses a link signed under another secret', () => {
    setTestEnv({ APP_SECRET: '1'.repeat(64) });
    expect(fileLinkValid(FILE, link.expires, link.signature, signedAt)).toBe(false);
  });

  it.each([
    ['no expiry', null, 'x'],
    ['no signature', '1', null],
    ['an expiry that is not a number', '1e10', 'x'],
    ['a signature of the wrong length', '9999999999', 'short'],
  ])('refuses %s', (_, expires, signature) => {
    expect(fileLinkValid(FILE, expires, signature, signedAt)).toBe(false);
  });

  it('refuses an expiry further off than any it mints, whatever it is signed with', () => {
    const far = parts(widgetFileUrl(FILE, at('2027-11-04T10:00:00Z')));
    expect(fileLinkValid(FILE, far.expires, far.signature, signedAt)).toBe(false);
  });
});
