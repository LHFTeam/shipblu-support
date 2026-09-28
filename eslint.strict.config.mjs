import tseslint from 'typescript-eslint';
import base from './eslint.config.mjs';

// The type-aware rules, run by `npm run lint:strict` and by its own CI job. They
// catch the promise mistakes `tsc` cannot see — a job enqueued and never
// awaited, an async handler whose rejection nobody hears — and a switch over a
// union that stopped covering it when the union grew.
//
// They live in their own config rather than in eslint.config.mjs because type
// information is what makes them slow: `npm run lint` stays the fast loop, and
// this one reads the whole program once.
//
// The plan started them as warnings, to be promoted a directory at a time once
// each was clean (plans/refactor-in-stages.md, Stage 7). Measured, `lib/**` and
// `worker/**` had nothing to report, so they start at `error`. `app/**` joined
// once its two findings — both a promise that cannot reject, left unmarked — were
// fixed.
const config = [
  ...base,
  {
    files: ['lib/**/*.ts', 'lib/**/*.tsx', 'worker/**/*.ts', 'app/**/*.ts', 'app/**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // An async function passed as a JSX event handler is the ordinary shape
      // of a React form, and React does nothing with the promise either way.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
      // A `default` is a decision somebody made about the unknown case —
      // `mapVisibility` in lib/freshdesk/client.ts sends an unrecognised level
      // to `agents_only` so it cannot publish — so it counts as covering it.
      // What the rule is for is the switch with no default that silently
      // stopped covering a union when the union grew.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
    },
  },
];

export default config;
