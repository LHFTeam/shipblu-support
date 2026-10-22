import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * An unpositioned scroll container lets an `sr-only` box inside it be placed
 * against the document, which lengthens the page under the console (§6.81).
 * Every class list that scrolls vertically must also position the box, on
 * every branch and at every size it scrolls at.
 */

const PANE = (i) =>
  `export function Pane() {\n  return <div className="app-scroll relative h-full overflow-y-auto p-6">${i}</div>;\n}\n`;

/** Fifteen positioned panes: the rule's floor, so a case is only its own change. */
const PANES = many(15, (i) => `app/(console)/area${i}/pane.tsx`, PANE);

const page = (body) => `export function Page() {\n  return ${body};\n}\n`;

/**
 * One file per class expression, so each verdict is traceable to its case,
 * and the locations the rule reported, in a stable order.
 */
async function verdicts(expressions) {
  const cases = Object.fromEntries(
    expressions.map((expression, i) => [
      `components/case-${String(i).padStart(2, '0')}.tsx`,
      page(`<div className={${expression}} />`),
    ]),
  );
  const found = await runRule('scroll-positioned', { ...PANES, ...cases });
  return found.map((failure) => failure.where).sort();
}

/** Where `verdicts` reports case `i`: line 2 of its own file. */
const at = (...indices) =>
  indices.map((i) => `components/case-${String(i).padStart(2, '0')}.tsx:2`).sort();

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

  it('accepts any position, and importance written either way round', async () => {
    expect(
      await verdicts([
        '"absolute max-h-40 overflow-auto"',
        '"sticky overflow-y-scroll!"',
        '"fixed! overflow-scroll"',
        '"!relative max-h-40 overflow-y-auto"',
        '"md:!relative max-h-40 md:overflow-y-auto"',
      ]),
    ).toEqual([]);
  });

  it('counts a scroll utility whatever its importance', async () => {
    expect(
      await verdicts([
        '"max-h-40 !overflow-y-auto"',
        '"max-h-40 md:!overflow-y-auto"',
        '"max-h-40 overflow-y-auto!"',
      ]),
    ).toEqual(at(0, 1, 2));
  });

  it('reads an arbitrary property as the utility it spells', async () => {
    expect(
      await verdicts([
        '"max-h-40 [overflow-y:auto]"',
        '"max-h-40 [overflow:auto]"',
        '"max-h-40 md:[overflow-y:auto]"',
        '"[position:relative] max-h-40 overflow-y-auto"',
        '"![position:relative] max-h-40 [overflow-y:auto]"',
        '"max-h-40 [overflow-wrap:anywhere] [overflow-x:auto]"',
      ]),
    ).toEqual(at(0, 1, 2));
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

  it('accepts a position under exactly the variant the box scrolls under', async () => {
    expect(
      await verdicts([
        '"max-h-40 md:overflow-y-auto md:relative"',
        '"md:hover:overflow-y-auto md:hover:relative"',
        '"min-[1366px]:overflow-y-auto min-[1366px]:sticky"',
        '"[&:hover]:overflow-y-auto [&:hover]:relative"',
        '"relative max-h-64 md:overflow-y-auto"',
      ]),
    ).toEqual([]);
  });

  it('refuses a position under any other variant, even one that would cover it', async () => {
    expect(
      await verdicts([
        '"md:overflow-y-auto max-md:relative"',
        '"overflow-y-auto md:overflow-y-scroll md:relative"',
        '"lg:overflow-y-auto md:relative"',
        '"[&:lang(ar)]:relative max-h-40 overflow-y-auto"',
        '"supports-[display:grid]:overflow-y-auto relative-ish"',
      ]),
    ).toEqual(at(0, 1, 2, 3, 4));
  });

  it('counts a position the template or concatenation always carries', async () => {
    expect(
      await verdicts([
        '`relative ${open ? "overflow-y-auto" : "overflow-hidden"} p-2`',
        '`${overlay ? "absolute inset-0" : "relative"} overflow-y-auto`',
        '"relative " + (open ? "overflow-y-auto" : "overflow-hidden")',
        '(`relative overflow-y-auto` as string)',
      ]),
    ).toEqual([]);
  });

  it('refuses a position that only some renders carry', async () => {
    expect(
      await verdicts([
        '`${pinned ? "relative" : ""} overflow-y-auto`',
        'a ? "relative overflow-y-auto" : "overflow-y-auto"',
        '`${a && "relative"} overflow-y-auto`',
        '`${a ?? "relative"} overflow-y-auto`',
        '"overflow-y-auto " + (a ? "relative" : "")',
        '`${a ? "relative" : "md:relative"} overflow-y-auto`',
        'cn("relative", "overflow-y-auto")',
      ]),
    ).toEqual(at(0, 1, 2, 3, 4, 5, 6));
  });

  it('reports a class list once, at the text that is not positioned', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'components/panel.tsx':
        'export function Panel() {\n  return (\n    <div\n      className={\n        open\n          ? "relative overflow-y-auto"\n          : "overflow-y-auto"\n      }\n    />\n  );\n}\n',
    });

    expect(found).toEqual([expect.objectContaining({ where: 'components/panel.tsx:7' })]);
  });

  it('refuses a static that takes the position back', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'components/drawer.tsx': page('<div className="fixed inset-0 md:static overflow-y-auto" />'),
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'components/drawer.tsx:2',
        message: expect.stringMatching(/`static` unpositions/),
      }),
    ]);
  });

  it('refuses a static under any variant, importance or condition', async () => {
    expect(
      await verdicts([
        '"relative md:static overflow-y-auto"',
        '"relative static overflow-y-auto"',
        '"relative !static overflow-y-auto"',
        '"relative rtl:static! overflow-y-auto"',
        '"relative md:[position:static] overflow-y-auto"',
        '`relative ${open ? "md:static" : ""} overflow-y-auto`',
        '"relative overflow-y-auto statistics data-[state=static]:p-2"',
      ]),
    ).toEqual(at(0, 1, 2, 3, 4, 5));
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

  it('reads a class constant in a .ts module', async () => {
    const found = await runRule('scroll-positioned', {
      ...PANES,
      'lib/ui/pane.ts':
        "export const PANE = 'max-h-64 overflow-y-auto';\nexport const LIST = cond ? 'relative overflow-auto' : 'overflow-auto';\n",
      'lib/ui/positioned.ts': "export const FINE = 'relative max-h-64 overflow-y-auto';\n",
    });

    expect(found.map((failure) => failure.where)).toEqual(['lib/ui/pane.ts:1', 'lib/ui/pane.ts:2']);
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
