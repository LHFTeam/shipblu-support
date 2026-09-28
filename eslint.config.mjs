import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

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
    },
  },
  // Layering. `lib/` is where the logic lives so that a page, an action and a
  // job all reach the same code; a `lib/` or `worker/` module importing from
  // `app/` turns that round, and the worker would then load a route module
  // that was only ever built for Next. `components/` are UI primitives that
  // client files import freely, so one reaching `db/` puts the schema — or the
  // pool — in the browser bundle (§6.57, and the `client-bundle` repo rule).
  // Relative spellings are listed beside the alias because either one resolves.
  {
    files: ['lib/**', 'worker/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(@/|(\\.\\./)+)app(/|$)',
              message: 'lib/ and worker/ may not import from app/. Move the shared code into lib/.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['components/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(@/|(\\.\\./)+)db(/|$)',
              message:
                'components/ may not import from db/. Take the data as a prop, or read it in lib/.',
            },
          ],
        },
      ],
    },
  },
];

export default config;
