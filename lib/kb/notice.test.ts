import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { serviceNotice } from './notice';

/**
 * Two things here are worth pinning, and both are about a notice failing to
 * reach somebody rather than about how it looks: the cross-locale fallback,
 * because the silent version of that bug hides a delivery warning from the
 * majority of readers, and the href check, because an anchor is the one place a
 * mistyped configuration value turns into script.
 */

const ORIGINAL = process.env;

function configure(extra: Record<string, string>) {
  process.env = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost:5432/test',
    APP_SECRET: '0'.repeat(64),
    ...extra,
  } as NodeJS.ProcessEnv;
  resetEnvCache();
}

beforeEach(() => configure({}));

afterEach(() => {
  process.env = ORIGINAL;
  resetEnvCache();
});

describe('serviceNotice', () => {
  it('is nothing at all until somebody writes one', () => {
    expect(serviceNotice('en')).toBeNull();
    expect(serviceNotice('ar')).toBeNull();
  });

  it('gives a reader their own language when it is set', () => {
    configure({
      KB_NOTICE_EN: 'Alexandria is running late.',
      KB_NOTICE_AR: 'تأخير في الإسكندرية.',
    });

    expect(serviceNotice('ar')).toMatchObject({
      body: 'تأخير في الإسكندرية.',
      lang: 'ar',
      dir: 'rtl',
    });
    expect(serviceNotice('en')).toMatchObject({ body: 'Alexandria is running late.', lang: 'en' });
  });

  it('falls back across locales rather than withholding the warning', () => {
    // Somebody filled in the English box and walked away. Arabic readers are
    // the majority of this site; showing them nothing is the worse failure.
    configure({ KB_NOTICE_EN: 'Alexandria is running late.' });

    expect(serviceNotice('ar')).toMatchObject({
      body: 'Alexandria is running late.',
      lang: 'en',
      dir: 'ltr',
    });
  });

  it('treats a blank notice as no notice', () => {
    configure({ KB_NOTICE_EN: '   ', KB_NOTICE_AR: '' });
    expect(serviceNotice('en')).toBeNull();
  });

  it('defaults to the warning tone, which is what a delay is', () => {
    configure({ KB_NOTICE_EN: 'Late.' });
    expect(serviceNotice('en')?.tone).toBe('warning');
  });

  describe('the link', () => {
    it('keeps an http(s) URL and a path on this site', () => {
      configure({ KB_NOTICE_EN: 'Late.', KB_NOTICE_HREF: 'https://status.shipblu.com/incident/4' });
      expect(serviceNotice('en')?.href).toBe('https://status.shipblu.com/incident/4');

      configure({ KB_NOTICE_EN: 'Late.', KB_NOTICE_HREF: '/en/a/delivery-delays' });
      expect(serviceNotice('en')?.href).toBe('/en/a/delivery-delays');
    });

    it('drops anything that is not, and keeps the notice', () => {
      for (const href of [
        'javascript:alert(1)',
        'data:text/html,x',
        '//evil.example',
        'nonsense',
      ]) {
        configure({ KB_NOTICE_EN: 'Late.', KB_NOTICE_HREF: href });
        const notice = serviceNotice('en');
        expect(notice?.href).toBeNull();
        expect(notice?.body).toBe('Late.');
      }
    });
  });
});
