import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts', 'scripts/**/*.test.mjs'],
    // The database tier has its own config, vitest.db.config.mts: unit tests
    // run with no database at all, and those tests cannot run without one.
    exclude: ['node_modules/**', '.next/**', '**/*.db.test.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(root),
    },
  },
});
