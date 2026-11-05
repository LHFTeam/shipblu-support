import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * The focus ring stays in a cascade layer, a field does not trade it for a
 * translucent box-shadow, and no outline utility carries an important suffix
 * it no longer needs.
 *
 * The important modifier is added by `bang` (after) and `lead` (before)
 * rather than written into a class below: Tailwind scans this file like any
 * other, and a literal one would put a utility nothing uses into the served
 * stylesheet.
 */
const bang = (utility) => `${utility}!`;
const lead = (utility) => `!${utility}`;

const RING = ':where(a, button, input, select, textarea, summary, [tabindex]):focus-visible';

/** The stylesheet as it is now: the shared ring inside `@layer base`. */
const LAYERED = [
  "@import 'tailwindcss';",
  '/* The ring, in a layer. Comments mention :focus-visible { too. */',
  '@layer base {',
  `  ${RING} {`,
  '    outline: 2px solid blue;',
  '  }',
  '}',
  '',
].join('\n');

/** Ten class strings naming an outline: the rule's floor, so a case is only its own change. */
const FILLER = {
  'components/filler.tsx': `export const filler = [\n${"  'outline-hidden',\n".repeat(10)}];\n`,
};

const run = (files) => runRule('focus-ring', { 'app/globals.css': LAYERED, ...FILLER, ...files });

const at = (where, message) =>
  expect.objectContaining({ rule: 'focus-ring', where, message: expect.stringMatching(message) });

describe('focus-ring', () => {
  it('passes a layered ring, fields that keep it, and suppressions with a reason', async () => {
    const found = await run({
      'components/ui.tsx': [
        "const FIELD = 'rounded-md border focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20';",
        "const MAIN = 'flex-1 outline-none';",
        "const HEADING = 'text-sm font-semibold focus:outline-none';",
        "const INSIDE_A_BOX = 'resize-none bg-transparent outline-hidden';",
        "const ROW = 'focus-visible:outline-offset-[-2px] md:rounded-lg';",
        `const PRIMITIVE_CLASH = '${bang('w-48')} ${bang('md:rounded-lg')}';`,
        '',
      ].join('\n'),
    });

    expect(found).toEqual([]);
  });

  it('refuses the ring outside a layer, which outranks every utility', async () => {
    const found = await run({
      'app/globals.css': [
        "@import 'tailwindcss';",
        '',
        `${RING} {`,
        '  outline: 2px solid blue;',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([at('app/globals.css:3', /outside a cascade layer/)]);
  });

  it('refuses an unlayered focus style under a media query, and passes one layered inside it', async () => {
    const found = await run({
      'app/globals.css': [
        LAYERED,
        '@media (pointer: fine) {',
        '  .chip:focus-within { outline-offset: 0; }',
        '  @layer components {',
        '    .tab:focus { outline-offset: 1px; }',
        '  }',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([at('app/globals.css:10', /outside a cascade layer/)]);
  });

  it('fails when the shared ring is gone', async () => {
    const found = await run({ 'app/globals.css': "@import 'tailwindcss';\n" });

    expect(found).toEqual([at('app/globals.css', /ring is gone/)]);
  });

  it('refuses outline-none beside a translucent focus ring, in a string or a template', async () => {
    const found = await run({
      'app/(console)/admin/sla/forms.tsx': [
        'export const a =',
        "  'w-24 rounded-md border outline-none focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20';",
        'export const b = (h: string) =>',
        '  `${h} w-full border focus:outline-none focus-visible:ring-2 focus-visible:ring-(--color-feedback-danger-fg)/20`;',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/(console)/admin/sla/forms.tsx:2', /translucent focus ring/),
      at('app/(console)/admin/sla/forms.tsx:4', /translucent focus ring/),
    ]);
  });

  it('refuses an important outline utility, whatever its variants', async () => {
    const found = await run({
      'components/row.tsx': [
        `export const a = '${bang('outline-none')} text-sm';`,
        `export const b = 'flex ${bang('focus-visible:outline-offset-[-2px]')}';`,
        `export const c = \`\${x} ${bang('lg:focus-visible:outline-(--color-text-rail)')}\`;`,
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('components/row.tsx:1', /drop the !/),
      at('components/row.tsx:2', /drop the !/),
      at('components/row.tsx:3', /drop the !/),
    ]);
  });

  it('refuses every way of removing the outline beside a translucent ring, by name', async () => {
    const found = await run({
      'app/widget/field.ts': [
        "export const a = 'border outline-hidden focus:ring-2 focus:ring-(--color-border-focus)/20';",
        "export const b = 'border outline-0 focus:ring-2 focus:ring-(--color-border-focus)/20';",
        "export const c = 'border focus:outline-transparent focus-visible:ring-(--color-border-focus)/30';",
        "export const d = 'border outline-hidden focus:ring-2 focus:ring-(--color-border-focus)';",
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/widget/field.ts:1', /^outline-hidden beside a translucent focus ring/),
      at('app/widget/field.ts:2', /^outline-0 beside/),
      at('app/widget/field.ts:3', /^focus:outline-transparent beside/),
    ]);
  });

  it('refuses the leading spelling of the important modifier too', async () => {
    const found = await run({
      'components/row.tsx': [
        `export const a = '${lead('outline-none')} text-sm';`,
        `export const b = 'flex focus-visible:${lead('outline-offset-[-2px]')}';`,
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('components/row.tsx:1', /drop the !/),
      at('components/row.tsx:2', /drop the !/),
    ]);
  });

  it('refuses a focus style in a layer that competes with the utilities', async () => {
    const found = await run({
      'app/globals.css': [
        LAYERED,
        '@layer utilities {',
        '  .chip:focus-visible { outline-offset: 0; }',
        '}',
        '@layer overrides {',
        '  .tab:focus { outline-color: red; }',
        '}',
        '@layer components {',
        '  .card:focus-within { outline-offset: 4px; }',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/globals.css:10', /@layer utilities competes/),
      at('app/globals.css:13', /@layer overrides competes/),
    ]);
  });

  it('refuses an outline declared outside a layer on any selector, and passes a layered one', async () => {
    const found = await run({
      'app/globals.css': [
        LAYERED,
        '.kb-article a {',
        '  color: blue;',
        '  outline: none;',
        '}',
        '@media print {',
        '  .kb-noprint { outline-width: 0; }',
        '}',
        '@layer components {',
        '  .kb-panel { outline: 1px solid; }',
        '}',
        '.scroll-cue { background: white; }',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/globals.css:9', /outline declared outside a cascade layer/),
      at('app/globals.css:14', /outline declared outside a cascade layer/),
    ]);
  });

  it('does not read a comment, or a test file, as a class string', async () => {
    const found = await run({
      'components/note.tsx': `// ${bang('outline-none')} once beat the unlayered ring.\nexport const n = 1;\n`,
      'components/note.test.tsx': `export const t = '${bang('outline-none')}';\n`,
    });

    expect(found).toEqual([]);
  });

  it('fails when it finds too few outline class strings to be checking anything', async () => {
    const found = await runRule('focus-ring', { 'app/globals.css': LAYERED });

    expect(found).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/found only 0 class strings/) }),
    ]);
  });
});
