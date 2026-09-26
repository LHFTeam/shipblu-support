import { fail, read } from '../lib.mjs';

/**
 * A form's built-in questions are named in four places and have to agree.
 *
 * `SYSTEM_KEYS` in lib/forms/elements.ts is the list the parser accepts; each of
 * the three screens that renders a form carries its own label map, because the
 * help centre labels are per-locale `StringKey`s and the two console screens are
 * plain English. Adding a key without the labels is not a type error where the
 * map is a `Record<SystemKey, …>` only in TypeScript's eyes — it *is* one, but
 * the failure a reviewer meets first is an admin placing a question that renders
 * with no label, on the one screen nobody opened while building it.
 *
 * Checked here rather than trusted to `tsc` because the maps are the kind of
 * thing a hurried edit turns into a `Record<string, …>` to make an error go
 * away, and then nothing is checking them at all.
 */
export function checkFormSystemKeys() {
  const rule = 'form-system-keys';
  const source = read('lib/forms/elements.ts');

  const block = /export const SYSTEM_KEYS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block) {
    fail(rule, 'lib/forms/elements.ts', 'SYSTEM_KEYS is no longer a literal array this can read');
    return;
  }

  const keys = [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  if (keys.length === 0) {
    fail(rule, 'lib/forms/elements.ts', 'SYSTEM_KEYS parsed as empty');
    return;
  }

  // The console's new-ticket form deliberately has no map of its own: it uses
  // `SYSTEM_LABELS_EN` from elements.ts, which the server needs too. What is
  // left is the two that genuinely cannot share — the help centre's are
  // per-locale `StringKey`s, and the builder's name the audience each question
  // is for ("Their name (forms anybody can submit)").
  const renderers = [
    'lib/forms/elements.ts',
    'app/help/[locale]/forms/[slug]/form.tsx',
    'app/(console)/admin/forms/elements-builder.tsx',
  ];

  for (const file of renderers) {
    const labels = /SYSTEM_LABELS(?:_EN)?[^=]*=\s*\{([\s\S]*?)\n\};/.exec(read(file));
    if (!labels) {
      fail(rule, file, 'no SYSTEM_LABELS map found — a form question would render unlabelled');
      continue;
    }

    for (const key of keys) {
      if (!new RegExp(`\\b${key}\\s*:`).test(labels[1])) {
        fail(rule, file, `SYSTEM_LABELS is missing "${key}", which SYSTEM_KEYS accepts`);
      }
    }
  }
}
