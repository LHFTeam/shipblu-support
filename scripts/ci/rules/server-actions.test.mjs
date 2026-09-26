import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * Every export of a `'use server'` module is a public POST endpoint, so the
 * directive and the file name have to agree in both directions — an action
 * file that lacks it, and a directive anywhere else, are each an endpoint a
 * reviewer does not see as one.
 */

/** Five well-formed action files: the rule's floor, so a case is only its own change. */
const ACTIONS = many(
  5,
  (i) => `app/area${i}/actions.ts`,
  (i) => `'use server';\n\nexport async function act${i}() {}\n`,
);

describe('server-actions', () => {
  it('passes a tree whose actions all carry the directive', async () => {
    expect(await runRule('server-actions', ACTIONS)).toEqual([]);
  });

  it('accepts a <domain>-actions.ts sibling', async () => {
    const found = await runRule('server-actions', {
      ...ACTIONS,
      'app/(console)/admin/settings-actions.ts':
        "'use server';\n\nexport async function save() {}\n",
    });

    expect(found).toEqual([]);
  });

  it('refuses an action file without the directive', async () => {
    const found = await runRule('server-actions', {
      ...ACTIONS,
      'app/area0/actions.ts': 'export async function act0() {}\n',
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/area0/actions.ts',
        message: expect.stringMatching(/must start with 'use server'/),
      }),
    ]);
  });

  it('refuses the directive in a module not named as an action file', async () => {
    const found = await runRule('server-actions', {
      ...ACTIONS,
      'lib/helpers.ts': "// a header comment\n'use server';\n\nexport async function helper() {}\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'lib/helpers.ts:2',
        message: expect.stringMatching(/must be named actions\.ts/),
      }),
    ]);
  });

  it('refuses a directive inlined into a function body', async () => {
    const found = await runRule('server-actions', {
      ...ACTIONS,
      'app/area0/page.tsx':
        "export default function Page() {\n  async function save() {\n    'use server';\n  }\n  return null;\n}\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/area0/page.tsx:3',
        message: expect.stringMatching(/inline 'use server'/),
      }),
    ]);
  });

  it('leaves the words alone where they are a string, not a directive', async () => {
    const found = await runRule('server-actions', {
      ...ACTIONS,
      'lib/directives.test.ts':
        "const DIRECTIVE = 'use server';\nexpect(DIRECTIVE).toBe('use server');\n",
    });

    expect(found).toEqual([]);
  });

  it('fails when it finds too few action files to be checking anything', async () => {
    const found = await runRule('server-actions', {
      'app/area0/actions.ts': "'use server';\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/found only 1 server action files/),
      }),
    ]);
  });
});
