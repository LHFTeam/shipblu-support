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
//     `storedTokenFor` only by `lib/whatsapp/accounts.ts`,
//     `resealStoredCredentials` only by the rotation job, and the resolvers
//     built on `storedTokenFor` only by the worker. That is what "the web
//     service never decrypts a stored token" means in code. An allowlist
//     rather than "not from app/": a lib/ module wrapping a resolver — the
//     shared-function shape `lib/meta/profile-refresh.ts` has, which a server
//     action may import — reaches the web service without ever being under
//     app/. A module outside worker/ that genuinely needs one is named in
//     RESOLVER_IMPORTERS with its reason, so it arrives as a reviewed edit.
//     Nothing re-exports those names, and nothing imports the three modules
//     wholesale, because either would launder an import past the check.
//
// What it cannot see: a new export of accounts.ts itself that calls a resolver
// and is imported by a page or action. The resolvers' doc comments say they
// are worker-only; that half is review's.
// ---------------------------------------------------------------------------

const OWNER = 'lib/whatsapp/credentials.ts';
const OWNER_DB_TEST = 'lib/whatsapp/credentials.db.test.ts';
const ENVELOPE = 'lib/whatsapp/credential-envelope.ts';
const ACCOUNTS = 'lib/whatsapp/accounts.ts';
const STATUS = 'lib/whatsapp/credential-status.ts';

/** The names that open an envelope, and who may import each. */
const RESOLVERS = ['tokenForAccount', 'credentialsForAccount', 'credentialsForPhoneNumberId'];
const IMPORTERS = new Map([
  ['unseal', new Set([OWNER])],
  ['storedTokenFor', new Set([ACCOUNTS])],
  ['resealStoredCredentials', new Set(['worker/handlers/rotate-whatsapp-credentials.ts'])],
]);

/**
 * Modules outside `worker/` that may import a resolver, each with why. A module
 * named here may itself be imported only from `worker/` (checked below) — that
 * is the whole point of the list: it extends the worker, it does not open a
 * second road into the web service.
 */
const RESOLVER_IMPORTERS = new Map([
  [
    'lib/whatsapp/onboarding-complete.ts',
    'the second phase of connecting a number through Embedded Signup — subscribing, creating the channel, requesting the copy — runs in complete_coexistence_onboarding with the stored credential; it lives in lib/ beside the first phase, which the server action runs',
  ],
]);

const isTest = (file) => /\.test\.(ts|tsx|mts|mjs)$/.test(file);
const mayResolve = (file) => file.startsWith('worker/') || RESOLVER_IMPORTERS.has(file);

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
        // `token` at the end catches `storedToken` and `accessToken`, and
        // leaves `tokenType` — Meta's word for what kind of token, not one.
        if (/envelope|cipher|plaintext|secret/i.test(name) || /token$/i.test(name)) {
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
  const guarded = new Set([OWNER, ENVELOPE, ACCOUNTS, ...RESOLVER_IMPORTERS.keys()]);
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

      // A module allowed to resolve tokens is part of the worker, and only the
      // worker may import it — or the allowlist would be a way round itself.
      if (RESOLVER_IMPORTERS.has(target) && !file.startsWith('worker/')) {
        fail(
          rule,
          file,
          `imports ${target}, which resolves stored credentials on the worker's behalf — only modules under worker/ may import it (${RESOLVER_IMPORTERS.get(target)})`,
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
        } else if (RESOLVERS.includes(name) && !mayResolve(file)) {
          fail(
            rule,
            file,
            `imports ${name} outside the worker — resolving a token opens the stored credential, and a module outside worker/ can be reached from the web service (enqueue a job instead, or name this module in RESOLVER_IMPORTERS with its reason)`,
          );
        }
      }
    }
  }
}
