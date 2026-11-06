import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * The focus ring stays in a cascade layer and keeps its outline, a field does
 * not trade it for a box-shadow, and no outline utility carries an important
 * suffix it no longer needs.
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

/** Ten class strings naming an outline, above the rule's floor of eight, so a case is only its own change. */
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
        "const ROW = 'focus-visible:outline-offset-[-2px] md:rounded-lg';",
        `const PRIMITIVE_CLASH = '${bang('w-48')} ${bang('md:rounded-lg')}';`,
        "const OFFSET_ONLY = 'focus:ring-offset-2 focus-visible:ring-inset';",
        '',
      ].join('\n'),
      'app/help/skip-target.tsx': [
        "const MAIN = 'flex-1 outline-none';",
        "const HEADING = 'text-sm font-semibold focus:outline-none';",
        "const INSIDE_A_BOX = 'resize-none bg-transparent outline-hidden';",
        "const NOT_A_RING = 'outline-none focus:ring-offset-2';",
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

  it('refuses a shared ring whose outline has been edited away', async () => {
    const found = await run({
      'app/globals.css': [
        "@import 'tailwindcss';",
        '@layer base {',
        `  ${RING} {`,
        '    outline: 0;',
        '  }',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/globals.css:3', /^outline: 0 under a focus selector takes the keyboard ring off/),
      at('app/globals.css', /no longer declares an outline/),
    ]);
  });

  it('refuses removing the outline under a focus selector in any layer, and in an @utility', async () => {
    const found = await run({
      'app/globals.css': [
        LAYERED,
        '@layer components {',
        '  button:focus-visible { outline: none; }',
        '  .chip:focus { outline-width: 0px; }',
        '  .tab:focus-visible { outline: 2px solid transparent; }',
        '  .row:focus-within { outline-style: none !important; }',
        '  .pill:focus-visible { outline: 2px solid rgb(0 0 0); outline-offset: 0; }',
        '}',
        '@utility no-ring {',
        '  &:focus-visible { outline-color: transparent; }',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/globals.css:10', /^outline: none under a focus selector/),
      at('app/globals.css:11', /^outline-width: 0px under a focus selector/),
      at('app/globals.css:12', /^outline: 2px solid transparent under a focus selector/),
      at('app/globals.css:13', /^outline-style: none under a focus selector/),
      at('app/globals.css:17', /^outline-color: transparent under a focus selector/),
    ]);
  });

  it('places a nested layer by the first name of its path', async () => {
    const found = await run({
      'app/globals.css': [
        LAYERED,
        '@layer theme-overrides {',
        '  @layer base {',
        '    :focus-visible { outline-offset: 0; }',
        '    .kb-article a { outline: 1px solid; }',
        '  }',
        '}',
        '@layer base.forms {',
        '  .field:focus { outline-offset: 1px; }',
        '}',
        '@layer components {',
        '  @layer cards { .card:focus-within { outline-offset: 4px; } }',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/globals.css:11', /@layer theme-overrides\.base competes/),
      at('app/globals.css:12', /outline declared in @layer theme-overrides\.base/),
    ]);
  });

  it('judges outline declarations only, so a focus rule that changes a border passes anywhere', async () => {
    const found = await run({
      'app/globals.css': [
        LAYERED,
        '.kb-panel { border-color: grey; }',
        '.kb-panel:focus-within { border-color: blue; }',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([]);
  });

  it('reads an @utility as a utility, and a @variant or media query in a rule as that rule', async () => {
    const found = await run({
      'app/globals.css': [
        LAYERED,
        '@utility ring-inset {',
        '  &:focus-visible { outline-offset: -2px; }',
        '}',
        '.card {',
        '  @variant focus-visible { outline: none; }',
        '}',
        '.chip {',
        '  @variant focus-visible { outline-offset: 4px; }',
        '}',
        '.pill {',
        '  @media (hover: hover) { outline-width: 0; }',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/globals.css:13', /^outline: none under a focus selector/),
      at('app/globals.css:16', /focus outline outside a cascade layer/),
      at('app/globals.css:19', /outline declared outside a cascade layer/),
    ]);
  });

  it('refuses outline-none beside a focus ring, in a string or a template', async () => {
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
      at('app/(console)/admin/sla/forms.tsx:2', /in a module that draws a focus ring/),
      at('app/(console)/admin/sla/forms.tsx:4', /in a module that draws a focus ring/),
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
      at('components/row.tsx:1', /no ! is needed against it/),
      at('components/row.tsx:2', /no ! is needed against it/),
      at('components/row.tsx:3', /no ! is needed against it/),
    ]);
  });

  it('refuses every way of removing the outline beside a ring, by name, opaque rings too', async () => {
    const found = await run({
      'app/widget/field.ts': [
        "export const a = 'border outline-hidden focus:ring-2 focus:ring-(--color-border-focus)/20';",
        "export const b = 'border outline-0 focus:ring-2 focus:ring-(--color-border-focus)/20';",
        "export const c = 'border focus:outline-transparent focus-visible:ring-(--color-border-focus)/30';",
        "export const d = 'border outline-hidden focus:ring-2 focus:ring-(--color-border-focus)';",
        "export const e = 'border md:focus:outline-none aria-invalid:focus:ring-(--color-feedback-danger-fg)/20';",
        "export const f = 'flex outline-none focus-within:ring-2 focus-within:ring-(--color-border-focus)/20';",
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/widget/field.ts:1', /^outline-hidden in a module that draws a focus ring/),
      at('app/widget/field.ts:2', /^outline-0 in a module/),
      at('app/widget/field.ts:3', /^focus:outline-transparent in a module/),
      at('app/widget/field.ts:4', /^outline-hidden in a module/),
      at('app/widget/field.ts:5', /^md:focus:outline-none in a module/),
      at('app/widget/field.ts:6', /^outline-none in a module/),
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
      at('components/row.tsx:1', /no ! is needed against it/),
      at('components/row.tsx:2', /no ! is needed against it/),
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

  it('reads a rule that holds a nested rule, and skips keyframe steps', async () => {
    const found = await run({
      'app/globals.css': [
        LAYERED,
        '.kb-panel {',
        '  outline: none;',
        '  & a { color: blue; }',
        '}',
        '@keyframes pulse {',
        '  from { outline-offset: 0; }',
        '  to { outline-offset: 4px; }',
        '}',
        '@theme static {',
        '  @keyframes ring { from { outline-color: red; } }',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([at('app/globals.css:9', /outline declared outside a cascade layer/)]);
  });

  it('is not moved by a brace or a semicolon inside a string or url()', async () => {
    const found = await run({
      'app/globals.css': [
        "@import 'tailwindcss';",
        '@layer base {',
        "  .quote::before { content: '{'; }",
        '  .tick { background: url(data:image/svg+xml;utf8,<svg>{}</svg>); }',
        `  ${RING} { outline: 2px solid blue; }`,
        '}',
        '.after { outline: none; }',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([at('app/globals.css:7', /outline declared outside a cascade layer/)]);
  });

  it("refuses an outline declared in a layer that is not one of Tailwind's", async () => {
    const found = await run({
      'app/globals.css': [
        LAYERED,
        '@layer overrides {',
        '  .kb-article a { outline: none; }',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([at('app/globals.css:10', /outline declared in @layer overrides/)]);
  });

  it('reads a ring of any colour or opacity, behind any variant naming focus, as a focus ring', async () => {
    const rings = [
      'focus:ring-(--color-border-focus)/[0.2]',
      'focus:ring-(--color-focus-soft)',
      'focus:ring-[color:rgb(0_0_0/0.2)]',
      'focus-visible:ring-blu-500',
      'group-focus-within:ring-2',
      'has-[input:focus-visible]:ring-1',
    ];
    const files = Object.fromEntries(
      rings.map((ring, i) => [
        `components/ring-${i}.tsx`,
        `export const a = 'border outline-none ${ring}';\n`,
      ]),
    );

    const found = await run(files);

    expect(found).toEqual(
      rings.map((ring, i) =>
        at(
          `components/ring-${i}.tsx:1`,
          new RegExp(
            `^outline-none in a module that draws a focus ring \\(${ring.replace(/[[\]().*+?^$|\\/]/g, '\\$&')},`,
          ),
        ),
      ),
    );
  });

  it('sees a suppression and a ring split across the strings of one module', async () => {
    const found = await run({
      'components/ui.tsx': [
        "const FIELD_BASE = 'w-full rounded-md border outline-none';",
        'const FIELD_SURFACE = {',
        "  default: 'focus:border-(--color-border-focus) focus:ring-2 focus:ring-(--color-border-focus)/20',",
        '};',
        'export const field = (tone: keyof typeof FIELD_SURFACE) => `${FIELD_BASE} ${FIELD_SURFACE[tone]}`;',
        '',
      ].join('\n'),
      'app/(console)/editor.tsx': [
        "const RING = 'focus-visible:ring-2';",
        "export const a = (editing: boolean) => `${RING} ${editing ? 'outline-hidden' : ''}`;",
        "export const b = cn('outline-0', RING);",
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at(
        'app/(console)/editor.tsx:2',
        /^outline-hidden in a module that draws a focus ring \(focus-visible:ring-2, line 1\)/,
      ),
      at('app/(console)/editor.tsx:3', /^outline-0 in a module/),
      at(
        'components/ui.tsx:1',
        /^outline-none in a module that draws a focus ring \(focus:ring-2, line 3\)/,
      ),
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
