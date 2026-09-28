import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * One layering rule: files under `files` may not reach the top-level `dir`.
 *
 * `no-restricted-imports` sees only static imports and re-exports, so the same
 * pattern is also given to `no-restricted-syntax` for the two forms it misses —
 * a runtime `import()` and the inline type `import('…').Row`, which would
 * otherwise carry a schema type into a component with the lint job green.
 */
function layer(files, dir, message) {
  const source = `^(@/|(\\.\\./)+)${dir}(/|$)`;
  const literal = `Literal[value=/${source.replaceAll('/', '\\/')}/]`;
  return {
    files,
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: source, message }] }],
      'no-restricted-syntax': [
        'error',
        { selector: `ImportExpression > ${literal}`, message },
        { selector: `TSImportType ${literal}`, message },
      ],
    },
  };
}

// eslint-config-next v16 ships native flat configs, so these spread directly —
// no FlatCompat shim (which breaks under ESLint 10).
const config = [
  {
    ignores: ['node_modules/**', '.next/**', 'db/migrations/**'],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Everything logs through `logger(tag)` in lib/log.ts, whose `[tag]`
      // prefix is what Render's log search and docs/PROJECT-STATE.md quote. A
      // bare `console.*` is a line nobody can find by its tag.
      'no-console': 'error',
    },
  },
  // Where `console` is the point, not a shortcut. Each is a file, not a
  // directory, so a new module beside one of them is still checked.
  {
    files: [
      // The logger itself.
      'lib/log.ts',
      // Prints a raw delivery, redacted, in its own multi-line-safe shape.
      'lib/webhooks/log.ts',
      // Command-line entry points: their output is the terminal's.
      'scripts/**',
      'db/migrate.ts',
      'db/seed.ts',
      'db/baseline.ts',
      'worker/run-job.ts',
      // Hand-run diagnostics whose output is a report, with untagged and
      // blank-line-led lines that a logger would change.
      'worker/handlers/check-meta-permissions.ts',
      'worker/handlers/test-comment-permission.ts',
      // Its pool-pressure warnings are left alone with the rest of the pool
      // instrumentation, which is a separate fix (plans/refactor-in-stages.md).
      'db/client.ts',
      // Tests replace `console.*` to capture what a module printed.
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: { 'no-console': 'off' },
  },
  // Layering. `lib/` is where the logic lives so that a page, an action and a
  // job all reach the same code; a `lib/` or `worker/` module importing from
  // `app/` turns that round, and the worker would then load a route module
  // that was only ever built for Next. `components/` are UI primitives that
  // client files import freely, so one reaching `db/` puts the schema — or the
  // pool — in the browser bundle (§6.57, and the `client-bundle` repo rule).
  // Relative spellings are listed beside the alias because either one resolves.
  layer(
    ['lib/**', 'worker/**'],
    'app',
    'lib/ and worker/ may not import from app/. Move the shared code into lib/.',
  ),
  layer(
    ['components/**'],
    'db',
    'components/ may not import from db/. Take the data as a prop, or read it in lib/.',
  ),
];

export default config;
