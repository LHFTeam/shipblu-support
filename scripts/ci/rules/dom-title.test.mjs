import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * `title=` on a DOM element is a tooltip a phone never shows, so it is refused;
 * on a component it is a prop, and passes. Most cases here are ones a text
 * pattern or a hand-written walker got wrong — an arrow function before the
 * `title`, an element straight after JSX text, a brace or a `//` inside a quoted
 * string — which is why the rule reads the syntax tree instead.
 */

/** Five hundred DOM elements: the rule's floor, so a case is only its own change. */
const FILLER = {
  'components/filler.tsx': `export const Filler = () => (\n  <>\n${'    <i />\n'.repeat(500)}  </>\n);\n`,
};

/** One component whose JSX is `lines`, one per line, starting on line 3. */
const component = (...lines) =>
  `export function X() {\n  return (\n${lines.map((l) => `    ${l}\n`).join('')}  );\n}\n`;

const at = (file, line) => expect.objectContaining({ rule: 'dom-title', where: `${file}:${line}` });

const run = (files) => runRule('dom-title', { ...FILLER, ...files });

describe('dom-title', () => {
  it('passes a title that is a component prop', async () => {
    const found = await run({
      'app/(console)/reports/page.tsx': component(
        '<Section title="By channel" hint="Live">',
        '  <PageHeader title={`The last ${days} days`} />',
        '  <motion.div title="a member expression names a component" />',
        '</Section>',
      ),
    });

    expect(found).toEqual([]);
  });

  it('refuses a title on a DOM element', async () => {
    const found = await run({
      'components/badge.tsx': component('<span title="Open">o</span>'),
    });

    expect(found).toEqual([at('components/badge.tsx', 3)]);
  });

  // The inbox search box, as it was: `=>` ended the first pattern's tag early.
  it('sees past an arrow function in an earlier attribute, and names the title line', async () => {
    const found = await run({
      'app/(console)/inbox/list.tsx': component(
        '<input',
        '  value={value}',
        '  onChange={(e) => setValue(e.target.value)}',
        '  placeholder="Search for anything"',
        '  title="Finds a ticket by its number"',
        '/>',
      ),
    });

    expect(found).toEqual([at('app/(console)/inbox/list.tsx', 7)]);
  });

  it('sees past a > inside a quoted value, nested braces and a template literal', async () => {
    const found = await run({
      'components/row.tsx': component(
        '<div',
        '  aria-label="more > less"',
        "  style={{ top: open ? 0 : 1, transform: 'x' }}",
        "  className={`row ${active ? 'on' : 'off'}`}",
        '  onClick={() => { if (a > b) run({ n: 1 }); }}',
        '  title="Row"',
        '/>',
      ),
    });

    expect(found).toEqual([at('components/row.tsx', 8)]);
  });

  // Review on #325: a lookbehind meant to skip `useState<string>` skipped these.
  it('refuses an element that follows JSX text with no space', async () => {
    const found = await run({
      'components/hours.tsx': component(
        '<p>',
        '  Hours<abbr title="Service level">SLA</abbr>',
        '  (optional)<span title="x">a</span>',
        '</p>',
      ),
    });

    expect(found).toEqual([at('components/hours.tsx', 4), at('components/hours.tsx', 5)]);
  });

  // Review on #325: a brace count that ignored strings ended these tags early.
  it('refuses a title after a brace inside a quoted string', async () => {
    const found = await run({
      'components/brace.tsx': component(
        '<>',
        '  <div data-x={\'}\'} title="x" />',
        '  <div onClick={() => f(\'}\')} title="y" />',
        '</>',
      ),
    });

    expect(found).toEqual([at('components/brace.tsx', 4), at('components/brace.tsx', 5)]);
  });

  // Review on #325: stripComments blanked from `//` to the end of the line, and
  // from `/*` to the next `*/` anywhere in the file.
  it('refuses a title after a // or /* inside an attribute value', async () => {
    const found = await run({
      'components/links.tsx': component(
        '<>',
        '  <a href="//cdn.example.com/x">l</a><span title="x">s</span>',
        '  <input type="file" accept="image/*" />',
        '  <span title="y">t</span>',
        '</>',
      ),
    });

    expect(found).toEqual([at('components/links.tsx', 4), at('components/links.tsx', 6)]);
  });

  it('refuses a title on a custom element', async () => {
    const found = await run({
      'components/when.tsx': component('<relative-time title="x" datetime={at} />'),
    });

    expect(found).toEqual([at('components/when.tsx', 3)]);
  });

  it('refuses a DOM element nested in a component prop', async () => {
    const found = await run({
      'components/help.tsx': component(
        '<Tooltip content={<abbr title="SLA">SLA</abbr>}>?</Tooltip>',
      ),
    });

    expect(found).toEqual([at('components/help.tsx', 3)]);
  });

  it('does not read a title variable, or a type argument, as an attribute', async () => {
    const found = await run({
      'components/save.tsx': [
        'export function Save() {',
        "  const [title, setTitle] = useState<string>('');",
        '  return (',
        '    <button onClick={() => { const title = \'x\'; save(title); }} aria-label="Save">',
        '      {title}',
        '    </button>',
        '  );',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([]);
  });

  it('does not read a title in a comment', async () => {
    const found = await run({
      'components/note.tsx': [
        '// Not <span title="x">, which a phone never shows.',
        'export function Note() {',
        '  return <p>{/* nor <em title="y"> */}note</p>;',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([]);
  });

  it('leaves the files that predate the check to their own decision', async () => {
    const found = await run({
      'components/channel.tsx': component('<span title="WhatsApp">W</span>'),
    });

    expect(found).toEqual([]);
  });

  it('fails when it finds too few DOM elements to be checking anything', async () => {
    const found = await runRule('dom-title', {
      'components/badge.tsx': component('<span>o</span>'),
    });

    expect(found).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/found only 1 DOM elements/) }),
    ]);
  });
});
