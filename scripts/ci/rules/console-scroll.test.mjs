import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * The console shell clips its content column, so a page that opens no scroll
 * container is silently truncated (§6.53). Two things satisfy the rule:
 * `overflow-y-auto` in the page, or `<InboxShell>`, which lays out its own
 * panes. `admin/` pages get the wrapper from their layout and are not read.
 */

const WRAPPED = (i) =>
  `export default function Page() {\n  return <div className="app-scroll h-full overflow-y-auto p-6">${i}</div>;\n}\n`;

/** Eight wrapped pages: the rule's floor, so a case is only its own change. */
const PAGES = many(8, (i) => `app/(console)/area${i}/page.tsx`, WRAPPED);

describe('console-scroll', () => {
  it('passes pages that open their own scroll container', async () => {
    expect(await runRule('console-scroll', PAGES)).toEqual([]);
  });

  it('refuses a page with no scroll container', async () => {
    const found = await runRule('console-scroll', {
      ...PAGES,
      'app/(console)/contacts/page.tsx':
        'export default function Page() {\n  return <div className="p-6">rows</div>;\n}\n',
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/contacts/page.tsx',
        message: expect.stringMatching(/no scroll container/),
      }),
    ]);
  });

  it('does not count the class named only in a comment', async () => {
    const found = await runRule('console-scroll', {
      ...PAGES,
      'app/(console)/contacts/page.tsx':
        '// TODO: add overflow-y-auto\nexport default function Page() {\n  return <div className="p-6" />;\n}\n',
    });

    expect(found).toEqual([expect.objectContaining({ where: 'app/(console)/contacts/page.tsx' })]);
  });

  it('accepts a page that hands its height to InboxShell', async () => {
    const found = await runRule('console-scroll', {
      ...PAGES,
      'app/(console)/inbox/page.tsx':
        'export default function Page() {\n  return <InboxShell list={null} />;\n}\n',
    });

    expect(found).toEqual([]);
  });

  it('leaves admin pages to the layout that wraps them', async () => {
    const found = await runRule('console-scroll', {
      ...PAGES,
      'app/(console)/admin/teams/page.tsx':
        'export default function Page() {\n  return <div className="p-6" />;\n}\n',
    });

    expect(found).toEqual([]);
  });

  it('fails when it finds too few pages to be checking anything', async () => {
    const found = await runRule('console-scroll', {
      'app/(console)/area0/page.tsx': WRAPPED(0),
    });

    expect(found).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/found only 1 console pages/) }),
    ]);
  });
});
