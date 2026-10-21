import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * An unpositioned scroll container lets an `sr-only` box inside it be placed
 * against the document, which lengthens the page under the console (§6.81).
 * Every class list that scrolls vertically must also position the box.
 */

const PANE = (i) =>
  `export function Pane() {\n  return <div className="app-scroll relative h-full overflow-y-auto p-6">${i}</div>;\n}\n`;

/** Fifteen positioned panes: the rule's floor, so a case is only its own change. */
const PANES = many(15, (i) => `app/(console)/area${i}/pane.tsx`, PANE);

const page = (body) => `export function Page() {\n  return ${body};\n}\n`;

describe('scroll-positioned', () => {
  it('passes scroll containers that are positioned', async () => {
    expect(await runRule('scroll-positioned', PANES)).toEqual([]);
  });

  it('refuses a scroll container with no position', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'app/(console)/admin/layout.tsx': page(
        '<div className="app-scroll min-w-0 flex-1 overflow-y-auto">{children}</div>',
      ),
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/admin/layout.tsx:2',
        message: expect.stringMatching(/not positioned/),
      }),
    ]);
  });

  it('accepts any position, and the importance suffix on either utility', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'components/menu.tsx': page(
        '<><ul className="absolute max-h-40 overflow-auto" /><ul className="sticky overflow-y-scroll!" /><ul className="fixed! overflow-scroll" /></>',
      ),
    });

    expect(found).toEqual([]);
  });

  it('refuses a position that only applies from a breakpoint up', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'components/list.tsx': page('<ul className="md:relative max-h-40 overflow-y-auto" />'),
    });

    expect(found).toEqual([expect.objectContaining({ where: 'components/list.tsx:2' })]);
  });

  it('refuses a scroll utility under a variant as well', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'components/list.tsx': page('<ul className="max-h-40 md:overflow-y-auto" />'),
    });

    expect(found).toEqual([expect.objectContaining({ where: 'components/list.tsx:2' })]);
  });

  it('reads the whole className, across a template and its branches', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'components/panel.tsx': page(
        '<div className={`relative ${open ? "overflow-y-auto" : "overflow-hidden"} p-2`} />',
      ),
    });

    expect(found).toEqual([]);
  });

  it('does not take the word from a comment inside the attribute', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'components/panel.tsx': page(
        '<div className={/* relative */ `${open ? "overflow-y-auto" : ""} p-2`} />',
      ),
    });

    expect(found).toEqual([expect.objectContaining({ where: 'components/panel.tsx:2' })]);
  });

  it('reads a class constant outside JSX as one list', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'components/table.tsx':
        "const SCROLLER = 'max-h-64 overflow-y-auto';\nconst FINE = 'relative max-h-64 overflow-y-auto';\nexport function Table() {\n  return <div className={SCROLLER + FINE} />;\n}\n",
    });

    expect(found).toEqual([expect.objectContaining({ where: 'components/table.tsx:1' })]);
  });

  it('leaves horizontal scrollers and clipping boxes alone', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'components/table.tsx': page(
        '<><div className="overflow-x-auto" /><div className="h-dvh overflow-hidden" /></>',
      ),
    });

    expect(found).toEqual([]);
  });

  it('fails when it finds too few scroll containers to be checking anything', async () => {
    const found = await runRule('scroll-positioned', {
      'app/(console)/area0/pane.tsx': PANE(0),
    });

    expect(found).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/found only 1 vertical scroll containers/),
      }),
    ]);
  });
});
