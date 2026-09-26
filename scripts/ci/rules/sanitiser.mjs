import { fail, scannableSource, scan } from '../lib.mjs';

/**
 * Sanitising is done on write, never on read, through one module.
 *
 * Email bodies and imported KB HTML are attacker-controlled. A second call site
 * is how "sanitise on write" quietly becomes "sanitise wherever somebody
 * remembered", and a sanitiser configured twice is a sanitiser configured
 * differently in two places.
 */
export function checkSanitiserConfinement() {
  scan(
    scannableSource.filter((f) => f !== 'lib/html/sanitize.ts'),
    /from 'sanitize-html'|require\('sanitize-html'\)/g,
    (file, line) => {
      fail(
        'sanitiser',
        `${file}:${line}`,
        'imports sanitize-html directly — go through lib/html/sanitize.ts, which is the one place the policy is configured',
      );
    },
  );
}
