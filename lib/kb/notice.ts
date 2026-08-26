import { env } from '@/lib/env';
import { direction, LOCALES, type Locale } from './locale';

/**
 * The service notice across the top of the public help centre.
 *
 * "Deliveries in Alexandria are running 24–48h behind after yesterday's road
 * closures" is the sort of thing this carries: an operational fact with a short
 * life, written by somebody in ops, that every customer arriving with a question
 * about a late parcel should see before they ask it.
 *
 * It is read from the environment because there is nowhere else yet — the banner
 * is built, its backing store is not. That is a deliberate seam rather than a
 * placeholder: an ops person can put a notice in front of every customer from
 * the Render dashboard today, and when a `service_notices` table with a start,
 * an end and an author lands, this file is what changes and nothing that renders
 * it needs to know.
 *
 * Unset is no banner. An operational claim about ShipBlu's network has to be one
 * a person actually made, so there is no default text and no example left in
 * place to go stale.
 */

export type NoticeTone = 'info' | 'warning' | 'danger';

export type ServiceNotice = {
  body: string;
  tone: NoticeTone;
  href: string | null;
  /**
   * The locale the body is actually written in, which is not always the
   * reader's — see below. Rendered onto the element so a browser hyphenates and
   * a screen reader pronounces it correctly.
   */
  lang: Locale;
  dir: 'ltr' | 'rtl';
};

/**
 * The notice for a reader, or null.
 *
 * Their own language when it is set. **The other one when it is not**, marked
 * with its own `lang` and `dir`, rather than nothing at all. Falling back is the
 * uncomfortable choice and it is the right one: the failure it avoids is an ops
 * person filling in the English box, walking away, and every Arabic reader — who
 * are the majority — silently getting no warning about a delay that is affecting
 * their parcel. A banner in the wrong language is visibly wrong and gets
 * translated; a banner nobody sees is invisibly wrong and does not.
 */
export function serviceNotice(locale: Locale): ServiceNotice | null {
  const configured = env();
  const bodies: Record<Locale, string> = {
    en: (configured.KB_NOTICE_EN ?? '').trim(),
    ar: (configured.KB_NOTICE_AR ?? '').trim(),
  };

  const lang = bodies[locale] ? locale : LOCALES.find((option) => bodies[option]);
  if (!lang) return null;

  return {
    body: bodies[lang],
    tone: configured.KB_NOTICE_TONE,
    href: safeHref(configured.KB_NOTICE_HREF),
    lang,
    dir: direction(lang),
  };
}

/**
 * The link, if it is one we are willing to put in an `href`.
 *
 * An absolute http(s) URL or a path on this site, and nothing else. The value is
 * set by an operator rather than by a customer, so this is not the front line —
 * but `javascript:` in an anchor is a stored XSS whoever typed it, and a
 * validation that costs four lines is cheaper than the argument about whether
 * the environment is trusted.
 *
 * A bad value drops the link and keeps the notice. The banner's job is the
 * sentence; refusing to render an outage warning because its link was mistyped
 * would be the wrong half to discard.
 */
function safeHref(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;

  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
