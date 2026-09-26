import { fail, scannableSource, scan } from '../lib.mjs';

/**
 * ASCII slugify erases Arabic entirely, and Arabic is the default locale and the
 * front door. lib/kb/slug.ts is the one implementation that handles it.
 */
export function checkSlugConfinement() {
  scan(
    scannableSource.filter((f) => !f.startsWith('lib/kb/slug')),
    /\.replace\([^)]*\[\^a-z0-9\][^)]*\)/gi,
    (file, line) => {
      fail(
        'slugify',
        `${file}:${line}`,
        'looks like an ASCII slugify, which erases Arabic entirely — use slugify() from lib/kb/slug.ts',
      );
    },
  );
}
