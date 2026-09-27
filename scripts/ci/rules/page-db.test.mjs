import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * A page may not import `db/client`: its query would run nowhere before
 * production. `app/probe/page.tsx` is exempt by name, because reaching the
 * database from a page is exactly what it exists to test.
 */

const PAGE = (i) =>
  `import { listThings } from '@/lib/things';\nexport default async function Page() {\n  return <p>{(await listThings()).length} ${i}</p>;\n}\n`;

const PROBE =
  "import { databaseProbe } from '@/db/client';\nexport default async function Probe() {\n  await databaseProbe();\n  return null;\n}\n";

/** Forty pages that call lib/, and the probe: the rule's floor plus its one exemption. */
const PAGES = {
  ...many(40, (i) => `app/area${i}/page.tsx`, PAGE),
  'app/probe/page.tsx': PROBE,
};

describe('page-db', () => {
  it('passes pages that call lib/, and the probe that is exempt', async () => {
    expect(await runRule('page-db', PAGES)).toEqual([]);
  });

  it('refuses a page that imports the database client, and names the line', async () => {
    const found = await runRule('page-db', {
      ...PAGES,
      'app/(console)/admin/teams/page.tsx':
        "import { asc } from 'drizzle-orm';\nimport { db } from '@/db/client';\nexport default async function Page() {\n  return null;\n}\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/admin/teams/page.tsx:2',
        message: expect.stringMatching(/imports db\/client/),
      }),
    ]);
  });

  it('refuses the client reached by a relative path', async () => {
    const found = await runRule('page-db', {
      ...PAGES,
      'app/help/page.tsx':
        "import { db } from '../../db/client';\nexport default function Page() {\n  return null;\n}\n",
    });

    expect(found).toEqual([expect.objectContaining({ where: 'app/help/page.tsx:1' })]);
  });

  it('allows a page that imports a table from the schema, which runs no query', async () => {
    const found = await runRule('page-db', {
      ...PAGES,
      'app/help/page.tsx':
        "import type { kbArticles } from '@/db/schema';\nexport default function Page() {\n  return null;\n}\n",
    });

    expect(found).toEqual([]);
  });

  it('does not count the client named only in a comment', async () => {
    const found = await runRule('page-db', {
      ...PAGES,
      'app/help/page.tsx':
        "// Was: import { db } from '@/db/client';\nexport default function Page() {\n  return null;\n}\n",
    });

    expect(found).toEqual([]);
  });

  it('fails once the probe no longer needs its exemption', async () => {
    const found = await runRule('page-db', {
      ...PAGES,
      'app/probe/page.tsx': PAGE('probe'),
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/probe/page.tsx',
        message: expect.stringMatching(/remove it from EXEMPT/),
      }),
    ]);
  });

  it('fails when the exempt page no longer exists', async () => {
    const { 'app/probe/page.tsx': _probe, ...rest } = PAGES;

    expect(await runRule('page-db', rest)).toEqual([
      expect.objectContaining({
        where: 'app/probe/page.tsx',
        message: expect.stringMatching(/no such page/),
      }),
    ]);
  });

  it('fails when it finds too few pages to be checking anything', async () => {
    const found = await runRule('page-db', { 'app/probe/page.tsx': PROBE });

    expect(found).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/found only 1 page\.tsx files/) }),
    ]);
  });
});
