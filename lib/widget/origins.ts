import { env } from '@/lib/env';

/**
 * The origins a page carrying the widget may speak to it from.
 *
 * The same list `next.config.ts` builds `frame-ancestors` from — parsed twice
 * rather than shared, because that file is loaded by Next before any path alias
 * exists. Keep the two in step; they answer the same question for the two halves
 * of the same defence.
 *
 * Framing is the first half: `frame-ancestors` decides who may put the widget on
 * their page at all. This is the second: the widget takes instructions from its
 * parent — who the visitor is, and when to forget them — and a sibling iframe on
 * the host page can reach `parent.frames[…]` and post to us. Without this check
 * an advertisement on a merchant's dashboard could tell us its reader is
 * somebody else.
 *
 * The widget's own origin is not in the list and is allowed separately by the
 * caller: the help centre serves the snippet itself, so its frame is
 * same-origin and never needed a `WIDGET_ALLOWED_ORIGINS` entry.
 */
export function allowedHostOrigins(): string[] {
  return (env().WIDGET_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}
