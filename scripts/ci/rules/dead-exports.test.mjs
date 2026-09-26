import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * An exported value is live when another module names it in an import or a
 * re-export — a test file counts, since it is a module like any other. What
 * Next loads by name (a route's `GET`, a page's `metadata`) is live without an
 * importer, and a module reached without naming what it exports cannot be
 * judged at all. In a `'use server'` file an unimported export is a public
 * endpoint with no caller, so being used in its own module does not excuse it.
 */

/** Three hundred exports, all imported: the rule's floor. */
const NAMES = Array.from({ length: 300 }, (_, i) => `value${i}`);
const BASELINE = {
  'lib/many.ts': NAMES.map((name) => `export const ${name} = 1;`).join('\n') + '\n',
  'lib/uses.ts': `import { ${NAMES.join(', ')} } from './many';\n\nexport const all = [${NAMES.join(', ')}];\n`,
  'app/page.tsx':
    "import { all } from '@/lib/uses';\n\nexport default function Page() {\n  return all.length;\n}\n",
};

describe('dead-exports', () => {
  it('passes a tree where every exported value has an importer', async () => {
    expect(await runRule('dead-exports', BASELINE)).toEqual([]);
  });

  it('refuses an export nothing imports', async () => {
    const found = await runRule('dead-exports', {
      ...BASELINE,
      'lib/orphan.ts': 'export function orphan() {\n  return 1;\n}\n',
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'lib/orphan.ts:1',
        message: expect.stringMatching(/orphan is exported and no module imports it/),
      }),
    ]);
  });

  it('lets an over-exported helper its own module uses through', async () => {
    const found = await runRule('dead-exports', {
      ...BASELINE,
      'lib/helper.ts':
        'export function helper() {\n  return 1;\n}\n\nexport const twice = helper() + helper();\n',
      'lib/reads-twice.ts': "import { twice } from './helper';\n\nexport const shown = twice;\n",
      'app/other/page.tsx':
        "import { shown } from '@/lib/reads-twice';\n\nexport default function Page() {\n  return shown;\n}\n",
    });

    expect(found).toEqual([]);
  });

  it('refuses an unimported server action even when its own module uses it', async () => {
    const found = await runRule('dead-exports', {
      ...BASELINE,
      'app/area/actions.ts':
        "'use server';\n\nexport async function unused() {}\n\nexport async function used() {\n  return unused();\n}\n",
      'app/area/page.tsx':
        "import { used } from './actions';\n\nexport default function Page() {\n  return used;\n}\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/area/actions.ts:3',
        message: expect.stringMatching(/unused is a server action nothing imports/),
      }),
    ]);
  });

  it('counts an import from a test file as a use', async () => {
    const found = await runRule('dead-exports', {
      ...BASELINE,
      'lib/pure.ts': 'export function pure() {\n  return 1;\n}\n',
      'lib/pure.test.ts': "import { pure } from './pure';\n\npure();\n",
    });

    expect(found).toEqual([]);
  });

  it('leaves what Next loads by name to Next', async () => {
    const found = await runRule('dead-exports', {
      ...BASELINE,
      'app/api/health/route.ts': 'export async function GET() {\n  return new Response();\n}\n',
      'app/about/page.tsx':
        "export const metadata = { title: 'About' };\nexport const dynamic = 'force-dynamic';\n\nexport default function Page() {\n  return null;\n}\n",
    });

    expect(found).toEqual([]);
  });

  it('cannot judge a module imported as a namespace, and does not try', async () => {
    const found = await runRule('dead-exports', {
      ...BASELINE,
      'lib/tables.ts': 'export const first = 1;\nexport const second = 2;\n',
      'lib/all-tables.ts':
        "import * as tables from './tables';\n\nexport const count = Object.keys(tables).length;\n",
      'app/tables/page.tsx':
        "import { count } from '@/lib/all-tables';\n\nexport default function Page() {\n  return count;\n}\n",
    });

    expect(found).toEqual([]);
  });

  it('fails when it finds too few exports to be checking anything', async () => {
    const found = await runRule('dead-exports', {
      'lib/one.ts': 'export const one = 1;\n',
      'lib/two.ts': "import { one } from './one';\n\nconsole.log(one);\n",
    });

    expect(found).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/found only 1 value exports/) }),
    ]);
  });
});
