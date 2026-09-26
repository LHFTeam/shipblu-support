import { fail, read } from '../lib.mjs';

/**
 * X-Frame-Options: DENY everywhere except /widget, which uses frame-ancestors
 * with an explicit allowlist. Dropping the blanket DENY makes the console
 * clickjackable, and it is one header in one file.
 */
export function checkFramingHeaders() {
  const rule = 'framing';
  const config = read('next.config.ts');
  if (!/'X-Frame-Options',\s*value:\s*'DENY'/.test(config)) {
    fail(
      rule,
      'next.config.ts',
      'the blanket X-Frame-Options: DENY is gone — without it the console can be framed and clickjacked',
    );
  }
  if (!/frame-ancestors/.test(config)) {
    fail(
      rule,
      'next.config.ts',
      'the widget route no longer sets frame-ancestors, so its framing is unrestricted',
    );
  }
}
