import { describe, expect, it } from 'vitest';
import { many, runRule } from '../fixture.mjs';

/**
 * One answer to "is this an email address?": `isEmailAddress` and
 * `looksLikeEmail` in lib/auth/normalise.ts. Registration asked a regex of its
 * own and the verification email's job asked `z.email()`, and an address only
 * the first accepted died as an invalid payload (§6.117).
 */

/** Six modules asking the shared check: the rule's floor. */
const ASKING = many(
  6,
  (i) => `lib/form${i}.ts`,
  (i) =>
    `import { looksLikeEmail } from '@/lib/auth/normalise';\n\nexport const ok${i} = (v: string) => looksLikeEmail(v);\n`,
);

const DEFINITION = {
  'lib/auth/normalise.ts': [
    'const EMAIL_ADDRESS = /^[^\\s@]+@[^\\s@]+$/;',
    'export const isEmailAddress = (v: string) => EMAIL_ADDRESS.test(v);',
    'export const looksLikeEmail = (v: string) => isEmailAddress(v.trim());',
    '',
  ].join('\n'),
};

const run = (files) => runRule('email-check', { ...DEFINITION, ...ASKING, ...files });

const at = (where) => expect.objectContaining({ rule: 'email-check', where });

describe('email-check', () => {
  it('passes the definition, its callers, tests, prose and other questions about an address', async () => {
    const found = await run({
      'lib/queue/payloads.ts': [
        "import { z } from 'zod';",
        "import { isEmailAddress } from '@/lib/auth/normalise';",
        'export const to = z.string().refine(isEmailAddress);',
        '// was z.email(), and the form asked /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/',
        '',
      ].join('\n'),
      // A test holds the retired checks to show where they disagreed.
      'lib/auth/normalise.test.ts': 'const RETIRED = /^[^\\s@]+@[^\\s@]+$/;\nz.email();\n',
      'app/inbox/new/actions.db.test.ts': 'z.email();\n',
      // Plus-addressing and reply tokens ask something else of an address.
      'lib/email/threading.ts': 'export const token = /^[^+@]+\\+([^@]+)@/;\n',
      'lib/side-conversations/guard.ts':
        "export const bare = (a: string) => a.replace(/\\+[^@]*(?=@)/, '');\n",
      // Somebody else's `email` method.
      'lib/agents.ts': 'export const address = agent.email();\n',
    });

    expect(found).toEqual([]);
  });

  it('refuses a second schema for an address, in either of zod’s spellings', async () => {
    const found = await run({
      'lib/queue/payloads.ts': "import { z } from 'zod';\n\nexport const to = z.email();\n",
      'lib/env.ts':
        "import { z } from 'zod';\n\nexport const from = z.string().email().optional();\n",
    });

    expect(found).toEqual([at('lib/env.ts:3'), at('lib/queue/payloads.ts:3')]);
  });

  it('refuses an address-shaped regex, either way round', async () => {
    const found = await run({
      'app/help/account/actions.ts': [
        "'use server';",
        'export const a = (e: string) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(e);',
        'export const b = (e: string) => /^[^@\\s,;]+@[^@\\s,;]+$/.test(e);',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      at('app/help/account/actions.ts:2'),
      at('app/help/account/actions.ts:3'),
    ]);
  });

  it('reports itself checking nothing once the shared check is no longer asked', async () => {
    const found = await runRule('email-check', DEFINITION);

    expect(found).toEqual([
      expect.objectContaining({
        rule: 'email-check',
        where: 'lib/auth/normalise.ts',
        message: expect.stringContaining('found only 0 looksLikeEmail() call sites'),
      }),
    ]);
  });
});
