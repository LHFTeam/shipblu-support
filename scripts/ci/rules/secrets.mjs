import path from 'node:path';
import { fail, tracked } from '../lib.mjs';

/**
 * Secrets never enter the repo, and .env files are local only.
 *
 * A tracked .env is the single most direct way this rule gets broken, and git
 * remembers it after the delete.
 */
export function checkNoCommittedEnvFiles() {
  for (const file of tracked) {
    const base = path.basename(file);
    if (/^\.env($|\.)/.test(base) && base !== '.env.example') {
      fail(
        'secrets',
        file,
        'a .env file is committed — these are local only, and git remembers the value after it is deleted',
      );
    }
  }
}
