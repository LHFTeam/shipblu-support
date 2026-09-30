import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * `title=` on a DOM element is a tooltip no phone shows. The cases that matter
 * are the ones a pattern over JSX gets wrong: an arrow function among the
 * attributes, which the first version read as the end of the tag, and a
 * component's `title` prop, which is not an attribute at all.
 */

const FILE = 'components/search.tsx';

async function found(source) {
  return runRule('dom-title', { [FILE]: source });
}

describe('dom-title', () => {
  it('refuses a title on a DOM element', async () => {
    expect(await found('export const A = () => <input title="Search" />;\n')).toEqual([
      expect.objectContaining({ where: `${FILE}:1` }),
    ]);
  });

  it('refuses one that follows an arrow function in the same tag', async () => {
    const source = [
      'export const A = () => (',
      '  <input',
      '    onChange={(e) => setValue(e.target.value)}',
      '    title="Finds a ticket by its number"',
      '  />',
      ');',
      '',
    ].join('\n');

    expect(await found(source)).toEqual([expect.objectContaining({ where: `${FILE}:2` })]);
  });

  it('refuses one that follows a comparison or a generic type argument', async () => {
    const comparison = 'export const A = () => <button disabled={count > 0} title="Send" />;\n';
    const generic = [
      'export const A = () => (',
      '  <input onChange={(e: ChangeEvent<HTMLInputElement>) => f(e)} title="Search" />',
      ');',
      '',
    ].join('\n');

    expect(await found(comparison)).toEqual([expect.objectContaining({ where: `${FILE}:1` })]);
    expect(await found(generic)).toEqual([expect.objectContaining({ where: `${FILE}:2` })]);
  });

  it('does not mistake the word title in text or a string for the attribute', async () => {
    const source =
      'export const A = () => <p className="x">Set title="Hours" here, or {"title="}</p>;\n';

    expect(await found(source)).toEqual([]);
  });

  it("leaves a component's title prop alone", async () => {
    expect(await found('export const A = () => <Section title="Hours">x</Section>;\n')).toEqual([]);
  });

  it('does not reach past the end of a tag into a component inside it', async () => {
    const source =
      'export const A = () => <div onClick={() => go()}><Section title="Hours" /></div>;\n';

    expect(await found(source)).toEqual([]);
  });
});
