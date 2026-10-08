import {
  fail,
  lineOf,
  moduleEdges,
  read,
  resolveModule,
  scan,
  scannableSource,
  stripComments,
} from '../lib.mjs';

// ---------------------------------------------------------------------------
// The stored WhatsApp credential
//
// A business token minted by Embedded Signup is the one credential this
// database holds, sealed in `whatsapp_account_credentials` under a key it never
// sees. What makes holding it acceptable is where it may go, and each of those
// is a one-line mistake away from not being true — a star select in a page, an
// import of a resolver into a server action, a status type that grows the
// envelope "for debugging". So they are checked rather than asked for:
//
//  1. Only `lib/whatsapp/credentials.ts` names the table — by its Drizzle
//     identifier or its SQL name — so every read of it is in one file a
//     reviewer can hold in their head. (The schema declares it; the envelope
//     module spells the SQL name into its authenticated data.)
//  2. That module never selects a whole row: no empty `select()`, no empty
//     `returning()`, no relational `db.query`, each of which would carry the
//     envelope out without opening it.
//  3. `CredentialStatus`, the shape the admin page is handed, has no field that
//     could hold the secret — that page renders its props into an RSC payload.
//  4. Decryption has one road out: `unseal` is imported only by the owner,
//     `storedTokenFor` only by `lib/whatsapp/accounts.ts`, and nothing under
//     `app/` or `components/` imports the resolvers built on it. That is what
//     "the web service never decrypts a stored token" means in code. Nothing
//     re-exports those names, and nothing imports the three modules wholesale,
//     because either would launder an import past the check above.
//
// What it cannot see: a new export of accounts.ts that calls the resolvers and
// is itself imported by a page. The resolvers' doc comments say they are
// worker-only; that half is review's.
// ---------------------------------------------------------------------------

const OWNER = 'lib/whatsapp/credentials.ts';
const OWNER_DB_TEST = 'lib/whatsapp/credentials.db.test.ts';
const ENVELOPE = 'lib/whatsapp/credential-envelope.ts';
const ACCOUNTS = 'lib/whatsapp/accounts.ts';
const STATUS = 'lib/whatsapp/credential-status.ts';

/** The names that hand back a plaintext token, and who may import each. */
const RESOLVERS = ['tokenForAccount', 'credentialsForAccount', 'credentialsForPhoneNumberId'];
const IMPORTERS = new Map([
  ['unseal', new Set([OWNER])],
  ['storedTokenFor', new Set([ACCOUNTS])],
]);

const isTest = (file) => /\.test\.(ts|tsx|mts|mjs)$/.test(file);
const isWebOnly = (file) => file.startsWith('app/') || file.startsWith('components/');

export function checkCredentialConfinement() {
  const rule = 'credential-confinement';

  // 1. Who names the table.
  const mayNameIdentifier = new Set([
    'db/schema/config.ts',
    'db/schema/index.ts',
    OWNER,
    OWNER_DB_TEST,
  ]);
  scan(
    scannableSource.filter((f) => !mayNameIdentifier.has(f)),
    /\bwhatsappAccountCredentials\b/g,
    (file, line) => {
      fail(
        rule,
        `${file}:${line}`,
        'names whatsappAccountCredentials — only lib/whatsapp/credentials.ts may read or write the stored credential; call credentialStatuses() or one of its other exports',
      );
    },
  );

  const mayNameTable = new Set(['db/schema/config.ts', OWNER, OWNER_DB_TEST, ENVELOPE]);
  scan(
    scannableSource.filter((f) => !mayNameTable.has(f)),
    /\bwhatsapp_account_credentials\b/g,
    (file, line) => {
      fail(
        rule,
        `${file}:${line}`,
        'names the whatsapp_account_credentials table in SQL — a raw query here would read the envelope outside lib/whatsapp/credentials.ts',
      );
    },
  );

  // 2. The owner never selects a whole row.
  if (!scannableSource.includes(OWNER)) {
    fail(rule, OWNER, 'is missing — the stored credential has no owner to confine it to');
  } else {
    const owner = stripComments(read(OWNER));
    for (const [pattern, what] of [
      [/\.select\(\s*\)/g, 'an empty select()'],
      [/\.returning\(\s*\)/g, 'an empty returning()'],
      [/\.query\.\w+/g, 'the relational db.query API'],
    ]) {
      for (const match of owner.matchAll(pattern)) {
        fail(
          rule,
          `${OWNER}:${lineOf(owner, match.index)}`,
          `uses ${what}, which selects every column — the envelope included — without opening it; name the columns`,
        );
      }
    }
  }

  // 3. The status shape holds nothing secret.
  if (!scannableSource.includes(STATUS)) {
    fail(rule, STATUS, 'is missing — could not check the CredentialStatus type');
  } else {
    const status = stripComments(read(STATUS));
    const shape = status.match(/export type CredentialStatus = \{([\s\S]*?)\n\};/);
    if (!shape) {
      fail(rule, STATUS, 'could not find the CredentialStatus type');
    } else {
      for (const field of shape[1].matchAll(/^\s{2}([A-Za-z0-9_$]+)\??:/gm)) {
        const name = field[1];
        if (/envelope|cipher|plaintext|secret/i.test(name) || /^(access)?token$/i.test(name)) {
          fail(
            rule,
            STATUS,
            `CredentialStatus has a field named ${name} — the admin page renders this type into its props, so a secret here is published to the browser`,
          );
        }
      }
    }
  }

  // 4. The road out of decryption.
  const guarded = new Set([OWNER, ENVELOPE, ACCOUNTS]);
  for (const file of scannableSource) {
    if (isTest(file)) continue;

    for (const edge of moduleEdges(file)) {
      const target = resolveModule(edge.spec, file);
      if (target === null || !guarded.has(target) || edge.typeOnly) continue;

      if (edge.namespace) {
        fail(
          rule,
          file,
          `imports ${target} wholesale — name what it uses, so credential-confinement can see whether that includes a resolver`,
        );
        continue;
      }

      for (const name of edge.names) {
        const sensitive = IMPORTERS.has(name) || RESOLVERS.includes(name);
        if (!sensitive) continue;

        if (edge.kind === 'export') {
          fail(
            rule,
            file,
            `re-exports ${name}, which would let a module import it past credential-confinement`,
          );
          continue;
        }

        const allowed = IMPORTERS.get(name);
        if (allowed && !allowed.has(file)) {
          fail(
            rule,
            file,
            `imports ${name} — only ${[...allowed].join(', ')} may, so a decrypted token has one road out of lib/whatsapp/credentials.ts`,
          );
        } else if (isWebOnly(file)) {
          fail(
            rule,
            file,
            `imports ${name} into the web service — resolving a token opens the stored credential, and only the worker may (enqueue a job instead)`,
          );
        }
      }
    }
  }
}
