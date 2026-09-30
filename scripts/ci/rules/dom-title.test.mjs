import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * `title=` on a lowercase JSX element is a tooltip a phone never shows, so it is
 * refused; on a component it is a prop, and passes. The cases that matter are
 * the ones where the tag's own `>` is not the first `>` after its name — the
 * rule used to stop at any `>`, and an arrow function in an earlier attribute
 * hid the inbox search box's `title=` from it.
 */

const at = (file, line) => expect.objectContaining({ rule: 'dom-title', where: `${file}:${line}` });

describe('dom-title', () => {
  it('passes a title that is a component prop', async () => {
    const found = await runRule('dom-title', {
      'app/(console)/reports/page.tsx': [
        'export default function Page() {',
        '  return (',
        '    <Section title="By channel" hint="Live">',
        '      <PageHeader title={`The last ${days} days`} />',
        '      <motion.div title="a member expression names a component" />',
        '    </Section>',
        '  );',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([]);
  });

  it('refuses a title on a DOM element', async () => {
    const found = await runRule('dom-title', {
      'components/badge.tsx':
        'export function Badge() {\n  return <span title="Open">o</span>;\n}\n',
    });

    expect(found).toEqual([at('components/badge.tsx', 2)]);
  });

  // The inbox search box, as it was: `=>` ended the old pattern's tag early.
  it('sees past an arrow function in an earlier attribute, and names the title line', async () => {
    const found = await runRule('dom-title', {
      'app/(console)/inbox/list.tsx': [
        'function SearchBox() {',
        '  return (',
        '    <input',
        '      value={value}',
        '      onChange={(e) => setValue(e.target.value)}',
        '      placeholder="Search for anything"',
        '      title="Finds a ticket by its number"',
        '    />',
        '  );',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([at('app/(console)/inbox/list.tsx', 7)]);
  });

  it('sees past a > inside a quoted value, nested braces and a template literal', async () => {
    const found = await runRule('dom-title', {
      'components/row.tsx': [
        'export function Row() {',
        '  return (',
        '    <div',
        '      aria-label="more > less"',
        "      style={{ top: open ? 0 : 1, transform: 'x' }}",
        "      className={`row ${active ? 'on' : 'off'}`}",
        '      onClick={() => { if (a > b) run({ n: 1 }); }}',
        '      title="Row"',
        '    />',
        '  );',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([at('components/row.tsx', 8)]);
  });

  it('refuses a DOM element nested in a component prop', async () => {
    const found = await runRule('dom-title', {
      'components/help.tsx':
        'export function Help() {\n  return <Tooltip content={<abbr title="SLA">SLA</abbr>}>?</Tooltip>;\n}\n',
    });

    expect(found).toEqual([at('components/help.tsx', 2)]);
  });

  it('does not read a title inside an expression as an attribute', async () => {
    const found = await runRule('dom-title', {
      'components/save.tsx': [
        'export function Save() {',
        '  return (',
        '    <button onClick={() => { const title = \'x\'; save(title); }} aria-label="Save">',
        '      Save',
        '    </button>',
        '  );',
        '}',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([]);
  });

  it('does not read a title in a comment', async () => {
    const found = await runRule('dom-title', {
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
    const found = await runRule('dom-title', {
      'components/channel.tsx':
        'export function ChannelBadge() {\n  return <span title="WhatsApp">W</span>;\n}\n',
    });

    expect(found).toEqual([]);
  });
});
