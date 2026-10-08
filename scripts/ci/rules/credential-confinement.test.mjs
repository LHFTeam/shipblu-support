import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * The stored WhatsApp credential may be read by one module, opened by one
 * function, and resolved into a token only off the web service. Each case is a
 * one-line change that would quietly make one of those untrue.
 */

const OWNER = `import { whatsappAccountCredentials as credentials } from '@/db/schema';
import { unseal } from './credential-envelope';

export async function storedTokenFor(account) {
  const [row] = await db.select({ envelope: credentials.envelope }).from(credentials);
  return row ? unseal(row.envelope) : null;
}
export async function credentialStatuses() {
  return db.select({ keyId: credentials.keyId }).from(credentials);
}
export async function forgetStoredCredential() {}
`;

const ENVELOPE = `const TABLE = 'whatsapp_account_credentials';
export function unseal() {}
export function seal() {}
`;

const STATUS = `export type CredentialStatus = {
  accountId: string;
  keyId: string;
  tokenType: string | null;
};
`;

const ACCOUNTS = `import { storedTokenFor } from './credentials';
export async function tokenForAccount(account) {
  return storedTokenFor(account);
}
export async function credentialsForAccount(account) {
  return tokenForAccount(account);
}
export function parseTokenEnvVar(raw) {
  return raw;
}
`;

const TREE = {
  'db/schema/config.ts':
    "export const whatsappAccountCredentials = pgTable('whatsapp_account_credentials', {});\n",
  'db/schema/index.ts': "export * from './config';\n",
  'lib/whatsapp/credentials.ts': OWNER,
  'lib/whatsapp/credential-envelope.ts': ENVELOPE,
  'lib/whatsapp/credential-status.ts': STATUS,
  'lib/whatsapp/accounts.ts': ACCOUNTS,
  'worker/handlers/sync.ts':
    "import { credentialsForAccount } from '@/lib/whatsapp/accounts';\nexport async function sync(a) {\n  return credentialsForAccount(a);\n}\n",
  'app/(console)/admin/channels/actions.ts':
    "'use server';\nimport { parseTokenEnvVar } from '@/lib/whatsapp/accounts';\nimport { forgetStoredCredential } from '@/lib/whatsapp/credentials';\nexport async function save() {\n  parseTokenEnvVar('');\n  await forgetStoredCredential();\n}\n",
  'lib/whatsapp/credentials.db.test.ts':
    "import { whatsappAccountCredentials } from '@/db/schema';\nimport { storedTokenFor } from './credentials';\n",
};

describe('credential-confinement', () => {
  it('passes the owner, its resolvers in the worker, and an action that only forgets', async () => {
    expect(await runRule('credential-confinement', TREE)).toEqual([]);
  });

  it('refuses another module naming the table, by identifier or in SQL', async () => {
    const found = await runRule('credential-confinement', {
      ...TREE,
      'lib/admin/settings.ts':
        "import { whatsappAccountCredentials } from '@/db/schema';\nexport const all = () => db.select().from(whatsappAccountCredentials);\n",
      'lib/reports/raw.ts':
        'export const q = sql`select envelope from whatsapp_account_credentials`;\n',
    });

    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ where: 'lib/admin/settings.ts:1' }),
        expect.objectContaining({ where: 'lib/admin/settings.ts:2' }),
        expect.objectContaining({
          where: 'lib/reports/raw.ts:1',
          message: expect.stringMatching(/in SQL/),
        }),
      ]),
    );
    expect(found).toHaveLength(3);
  });

  it('refuses the owner selecting or returning a whole row', async () => {
    const found = await runRule('credential-confinement', {
      ...TREE,
      'lib/whatsapp/credentials.ts': `${OWNER}export const everything = () => db.select().from(credentials);
export const inserted = () => db.insert(credentials).values({}).returning();
export const relational = () => db.query.whatsappAccountCredentials.findMany();
`,
    });

    expect(found.map((failure) => failure.message)).toEqual([
      expect.stringMatching(/empty select\(\)/),
      expect.stringMatching(/empty returning\(\)/),
      expect.stringMatching(/relational db\.query/),
    ]);
  });

  it('refuses a status type that grows a field able to hold the secret', async () => {
    for (const field of ['envelope', 'ciphertext', 'token', 'accessToken', 'secretValue']) {
      const found = await runRule('credential-confinement', {
        ...TREE,
        'lib/whatsapp/credential-status.ts': STATUS.replace(
          '  keyId: string;\n',
          `  keyId: string;\n  ${field}?: string;\n`,
        ),
      });
      expect(found).toEqual([
        expect.objectContaining({ message: expect.stringContaining(`named ${field}`) }),
      ]);
    }
  });

  it('refuses a resolver imported anywhere under app/ or components/', async () => {
    const found = await runRule('credential-confinement', {
      ...TREE,
      'app/(console)/inbox/page.tsx':
        "import { tokenForAccount } from '@/lib/whatsapp/accounts';\nexport default function Page() {\n  return null;\n}\n",
      'components/token-debug.tsx':
        "import { credentialsForPhoneNumberId } from '@/lib/whatsapp/accounts';\nexport function Debug() {\n  return null;\n}\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        where: 'app/(console)/inbox/page.tsx',
        message: expect.stringMatching(/tokenForAccount into the web service/),
      }),
      expect.objectContaining({ where: 'components/token-debug.tsx' }),
    ]);
  });

  it('keeps the decrypting functions to their one importer each', async () => {
    const found = await runRule('credential-confinement', {
      ...TREE,
      'worker/handlers/peek.ts':
        "import { storedTokenFor } from '@/lib/whatsapp/credentials';\nimport { unseal } from '@/lib/whatsapp/credential-envelope';\nexport const peek = [storedTokenFor, unseal];\n",
    });

    expect(found).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/imports storedTokenFor — only lib\/whatsapp\/accounts\.ts/),
      }),
      expect.objectContaining({
        message: expect.stringMatching(/imports unseal — only lib\/whatsapp\/credentials\.ts/),
      }),
    ]);
  });

  it('refuses a re-export or a wholesale import that would launder a resolver past the check', async () => {
    const found = await runRule('credential-confinement', {
      ...TREE,
      'lib/whatsapp/index.ts': "export { tokenForAccount } from './accounts';\n",
      'app/(console)/reply-actions.ts':
        "'use server';\nimport * as accounts from '@/lib/whatsapp/accounts';\nexport async function reply() {\n  return accounts;\n}\n",
    });

    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: 'lib/whatsapp/index.ts',
          message: expect.stringMatching(/re-exports tokenForAccount/),
        }),
        expect.objectContaining({
          where: 'app/(console)/reply-actions.ts',
          message: expect.stringMatching(/wholesale/),
        }),
      ]),
    );
    expect(found).toHaveLength(2);
  });

  it('lets tests reach what they test', async () => {
    const found = await runRule('credential-confinement', {
      ...TREE,
      'lib/whatsapp/accounts.test.ts':
        "import { tokenForAccount } from './accounts';\nimport { unseal } from './credential-envelope';\n",
      'app/(console)/admin/channels/actions.test.ts':
        "import { credentialsForAccount } from '@/lib/whatsapp/accounts';\n",
    });

    expect(found).toEqual([]);
  });
});
