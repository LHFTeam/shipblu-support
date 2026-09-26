import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * A `'use client'` module that reaches `db/schema` or `db/client` ships the
 * schema — or the pool — to every browser, and only `node:fs` makes the build
 * fail on its own (§6.57). The walk follows value imports, stops at
 * `'use server'` modules, which the browser only ever calls, and ignores
 * `import type`, which the bundler erases.
 */

/** Twenty harmless client components: the rule's floor. */
const CLIENTS = many(
  20,
  (i) => `components/widget${i}.tsx`,
  (i) => `'use client';\n\nexport function Widget${i}() {\n  return null;\n}\n`,
);

const SCHEMA = { 'db/schema/index.ts': 'export const tickets = {};\n' };

describe('client-bundle', () => {
  it('passes client components that import nothing from the database', async () => {
    expect(await runRule('client-bundle', { ...CLIENTS, ...SCHEMA })).toEqual([]);
  });

  it('refuses a client component that reaches the schema, and names the route', async () => {
    const found = await runRule('client-bundle', {
      ...CLIENTS,
      ...SCHEMA,
      'lib/kb/internal.ts':
        "import { tickets } from '@/db/schema';\n\nexport const LABEL = tickets;\n",
      'components/editor.tsx':
        "'use client';\n\nimport { LABEL } from '@/lib/kb/internal';\n\nexport function Editor() {\n  return LABEL;\n}\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'components/editor.tsx',
        message: expect.stringMatching(
          /reaches db\/schema .* via lib\/kb\/internal\.ts → db\/schema\/index\.ts/,
        ),
      }),
    ]);
  });

  it('allows a type-only import, which the bundler erases', async () => {
    const found = await runRule('client-bundle', {
      ...CLIENTS,
      ...SCHEMA,
      'components/editor.tsx':
        "'use client';\n\nimport type { tickets } from '@/db/schema';\n\nexport function Editor(): typeof tickets | null {\n  return null;\n}\n",
    });

    expect(found).toEqual([]);
  });

  it("stops at a 'use server' module, which the browser only calls", async () => {
    const found = await runRule('client-bundle', {
      ...CLIENTS,
      ...SCHEMA,
      'app/area/actions.ts':
        "'use server';\n\nimport { tickets } from '@/db/schema';\n\nexport async function save() {\n  return tickets;\n}\n",
      'app/area/form.tsx':
        "'use client';\n\nimport { save } from './actions';\n\nexport function Form() {\n  return save;\n}\n",
    });

    expect(found).toEqual([]);
  });

  it('fails when it finds too few client components to be checking anything', async () => {
    const found = await runRule('client-bundle', {
      'components/widget.tsx': "'use client';\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/found only 1 'use client' entry points/),
      }),
    ]);
  });
});
