import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * A button whose `type` changes between renders is submitted by the click that
 * changed it (§6.90). Refused as an expression, and as the merge row's shape —
 * one button element in each branch of a conditional, with different types.
 * Everything else about a button passes.
 */

/** Sixty buttons: the rule's floor, so a case is only its own change. */
const FILLER = {
  'components/filler.tsx': `export const Filler = () => (\n  <>\n${'    <button type="button" />\n'.repeat(60)}  </>\n);\n`,
};

/** One component whose JSX is `lines`, one per line, starting on line 3. */
const component = (...lines) =>
  `export function X() {\n  return (\n${lines.map((l) => `    ${l}\n`).join('')}  );\n}\n`;

const at = (file, line) =>
  expect.objectContaining({ rule: 'button-type', where: `${file}:${line}` });

const run = (files) => runRule('button-type', { ...FILLER, ...files });

describe('button-type', () => {
  it('passes a literal type, written either way, and no type at all', async () => {
    const found = await run({
      'components/row.tsx': component(
        '<form>',
        '  <Button type="submit">Save</Button>',
        "  <button type={'button'} onClick={() => setOpen(true)}>Edit</button>",
        '  <Button onClick={() => setArmed(true)}>Delete</Button>',
        '</form>',
      ),
    });

    expect(found).toEqual([]);
  });

  it('refuses a type decided at render, on <button> and on <Button>', async () => {
    const found = await run({
      'app/(console)/contacts/[id]/merge.tsx': component(
        '<form>',
        "  <Button type={armed ? 'submit' : 'button'} onClick={() => setArmed(true)} />",
        '  <button type={kind}>Go</button>',
        '</form>',
      ),
    });

    expect(found).toEqual([
      at('app/(console)/contacts/[id]/merge.tsx', 4),
      at('app/(console)/contacts/[id]/merge.tsx', 5),
    ]);
  });

  // The merge row as it was: React keeps the node and flips its attribute.
  it('refuses one button in each branch of a conditional with different types', async () => {
    const found = await run({
      'app/(console)/contacts/[id]/merge.tsx': component(
        '<form>',
        '  {armed ? (',
        '    <Button type="submit" variant="danger">Merge into this contact</Button>',
        '  ) : (',
        '    <Button type="button" onClick={() => setArmed(true)}>Merge</Button>',
        '  )}',
        '</form>',
      ),
    });

    expect(found).toEqual([at('app/(console)/contacts/[id]/merge.tsx', 4)]);
  });

  it("reads a missing type as each element's own default", async () => {
    const found = await run({
      'components/a.tsx': component(
        '<>',
        // HTML's default for <button> is submit, so this is a change of type…
        '  {armed ? <button>Sure?</button> : <button type="button">x</button>}',
        // …and the <Button> component's default is button, so this is not.
        '  {armed ? <Button>Sure?</Button> : <Button type="button">x</Button>}',
        '</>',
      ),
    });

    expect(found).toEqual([at('components/a.tsx', 4)]);
  });

  it('passes a conditional whose branches share a type, or are different elements', async () => {
    const found = await run({
      'components/b.tsx': component(
        '<>',
        '  {open ? <Button type="button">Close</Button> : <Button type="button">Open</Button>}',
        '  {armed ? <SubmitButton idle="Sure?" /> : <Button type="button">Delete</Button>}',
        '  {busy ? <span>…</span> : <button type="submit">Send</button>}',
        '</>',
      ),
    });

    expect(found).toEqual([]);
  });

  it('reports a conditional over an expression type once, at the attribute', async () => {
    const found = await run({
      'components/c.tsx': component(
        '<>',
        '  {armed ? <Button type={kind}>Sure?</Button> : <Button type="button">x</Button>}',
        '</>',
      ),
    });

    expect(found).toEqual([at('components/c.tsx', 4)]);
  });

  it('leaves ConfirmSubmit, the one place a type changes, to its own reasoning', async () => {
    const found = await run({
      'components/confirm-submit.tsx': component("<Button type={armed ? 'submit' : 'button'} />"),
    });

    expect(found).toEqual([]);
  });

  it('fails when it finds too few buttons to be checking anything', async () => {
    const found = await runRule('button-type', {
      'components/one.tsx': component('<button type="button" />'),
    });

    expect(found).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/found only 1 <button>/) }),
    ]);
  });
});
