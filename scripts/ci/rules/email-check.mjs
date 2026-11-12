import { fail, requireAtLeast, scan, scannableSource } from '../lib.mjs';

/**
 * Whether a string is an email address has one answer here:
 * `isEmailAddress` in lib/auth/normalise.ts, which the send path parses a
 * recipient with, asked of a typed address through `looksLikeEmail` beside it.
 *
 * Four checks used to answer it. The help centre's registration asked a regex
 * of its own, `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, the side conversations and
 * their recipient directory another, the other forms `looksLikeEmail`, then a
 * third, and `send_notification_email` parsed `to` with `z.email()`. So on
 * 2026-11-12 registration stored an account for a Gmail address with two dots
 * in a row and queued its verification link, and the job refused the address
 * on its first attempt as an invalid payload: no link, and a customer told to
 * check an inbox nothing reached (`docs/PROJECT-STATE.md` §6.117). Two
 * definitions of one thing drift whether or not they start the same, and the
 * drift surfaces in a dead job nobody reads.
 *
 * So, outside the definition and outside tests (which hold the retired checks
 * to show where they disagreed):
 *   - no `z.email(`, nor zod's older spelling at the end of a string chain —
 *     `z.string().email(`, `z.string().trim().email(`, `z.coerce.string()…`:
 *     a schema refines with `isEmailAddress`;
 *   - no address-shaped regex anchored at both ends: a negated character
 *     class holding both `@` and `\s`, in any order and beside anything else
 *     (`[^\s@]`, `[^,;\s@]`), which is how every retired check was written,
 *     or the two other usual spellings, `\S+@` and `[^@]+@[^@]`, inside a
 *     `/^…$/` literal: a form asks `looksLikeEmail`.
 * Only anchored ones, because only a pattern that must match the whole string
 * answers "is this an address?". One that finds or pulls an address out of a
 * header or a body — `/<([^<>\s@]+@[^<>\s]+)>/`, `/\S+@\S+/g` — answers
 * another question, which a boolean cannot, and passes; so does a
 * plus-address or local-part parser, `[^+@]+\+`, `\+[^@]*(?=@)`.
 *
 * What it cannot see: a pattern built from a string (`new RegExp(…)`), an
 * address check spelled another way (`[a-z0-9._%+-]+@…`, `.+@.+`), a
 * validator from another package, and `.email(` on a zod chain split across a
 * variable or holding a nested call.
 */
export function checkOneEmailCheck() {
  const rule = 'email-check';
  const definition = 'lib/auth/normalise.ts';
  const sources = scannableSource.filter(
    (f) => f !== definition && !/\.test\.(tsx?|mts|mjs)$/.test(f),
  );

  scan(
    sources,
    /\bz\s*\.\s*email\s*\(|\bz\s*\.\s*(?:coerce\s*\.\s*)?string\(\s*\)(?:\s*\.\s*\w+\([^()]*\))*\s*\.\s*email\s*\(/g,
    (file, line) => {
      fail(
        rule,
        `${file}:${line}`,
        "a second definition of an email address — a schema refines with `isEmailAddress` from '@/lib/auth/normalise', the one every form asks through `looksLikeEmail` (§6.117)",
      );
    },
  );

  // Once per line: one regex holds the class on both sides of its `@`. And only
  // inside a literal anchored at both ends, read off the match's own line: a
  // `/^` before it and a `$/` after it.
  const reported = new Set();
  const addressShaped = /\[\^(?=[^\]\n]*@)(?=[^\]\n]*\\s)[^\]\n]*\]|\\S\+@|\[\^@\]\+@\[\^@\]/g;
  scan(sources, addressShaped, (file, line, match, contents) => {
    const start = contents.lastIndexOf('\n', match.index) + 1;
    const end = contents.indexOf('\n', match.index);
    const before = contents.slice(start, match.index);
    const after = contents.slice(match.index, end < 0 ? undefined : end);
    if (!before.includes('/^') || !after.includes('$/')) return;
    if (reported.has(`${file}:${line}`)) return;
    reported.add(`${file}:${line}`);
    fail(
      rule,
      `${file}:${line}`,
      "an address-shaped regex is a second definition of an email address — ask `looksLikeEmail` from '@/lib/auth/normalise', which answers what the send path answers (§6.117)",
    );
  });

  // The floor is on the shared check's call sites: renamed, it would leave this
  // rule refusing second definitions of a check nothing asks.
  let uses = 0;
  scan(sources, /\blooksLikeEmail\(/g, () => {
    uses++;
  });
  requireAtLeast(rule, definition, uses, 6, 'looksLikeEmail() call sites');
}
