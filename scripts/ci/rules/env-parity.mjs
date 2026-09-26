import { fail, read } from '../lib.mjs';

// ---------------------------------------------------------------------------
// Environment variables: lib/env.ts and render.yaml describe the same system
//
// AGENTS.md: "Environment variables are declared in lib/env.ts (Zod, parsed
// lazily) and in render.yaml in the same commit."
//
// The failure this prevents is not a build error, it is a silent one. A variable
// the code reads and the blueprint never mentions is a variable nobody sets on
// the new environment, and the symptom arrives later as a channel that stopped
// working. INSTAGRAM_APP_SECRET is the worked example: unset, every Instagram
// delivery is answered 403 and the log blames a forgery.
// ---------------------------------------------------------------------------
export function checkEnvParity() {
  const rule = 'env-parity';
  const envTs = read('lib/env.ts');
  const renderYaml = read('render.yaml');

  // The schema block only — helper functions below it name the same variables
  // and would otherwise read as declarations.
  const schemaStart = envTs.indexOf('const schema = z.object({');
  const schemaEnd = envTs.indexOf('export type Env');
  const schema = envTs.slice(schemaStart, schemaEnd);

  const declared = [...schema.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s/gm)].map((m) => m[1]);

  if (declared.length < 20) {
    fail(
      rule,
      'lib/env.ts',
      `only parsed ${declared.length} keys out of the Zod schema — the parser above is out of date with the file's shape`,
    );
    return;
  }

  /**
   * Set by the platform rather than by us, so they are not in the Zod schema and
   * must not be reported as undeclared when render.yaml sets them.
   */
  const platformOwned = new Set(['NODE_VERSION', 'NODE_ENV', 'PORT']);

  for (const key of declared) {
    // A key counts as present whether render.yaml declares it (`- key: X`) or
    // lists it in a group's dashboard-owned comment. Both are deliberate: a
    // group cannot carry a secret's value, so the comment *is* the declaration.
    // See the note at the top of render.yaml.
    if (!new RegExp(`\\b${key}\\b`).test(renderYaml)) {
      fail(
        rule,
        'render.yaml',
        `${key} is declared in lib/env.ts but never mentioned in render.yaml — add it to a group's key list or its dashboard-owned comment`,
      );
    }
  }

  const inYaml = [...renderYaml.matchAll(/^\s*-?\s*key:\s*([A-Z][A-Z0-9_]*)/gm)].map((m) => m[1]);
  for (const key of new Set(inYaml)) {
    if (platformOwned.has(key)) continue;
    // A per-account WhatsApp credential is named by a database row, so it cannot
    // be in the schema — but the name must still start WHATSAPP_TOKEN_, which is
    // what stops an admin choosing which secret gets sent to Meta as a bearer
    // token (lib/whatsapp/accounts.ts).
    if (key.startsWith('WHATSAPP_TOKEN_')) continue;
    if (!declared.includes(key)) {
      fail(
        rule,
        'render.yaml',
        `${key} is set by render.yaml but not declared in lib/env.ts — every variable the system reads belongs in the schema`,
      );
    }
  }
}
