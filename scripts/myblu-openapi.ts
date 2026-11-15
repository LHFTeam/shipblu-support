import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openApiDocument } from '@/lib/api/openapi';

/**
 * Writes the myBlu API's contract to `docs/myblu-api.openapi.json`, from the
 * schemas the routes parse with (`lib/api/openapi.ts`).
 *
 *     npm run api:openapi
 *
 * The npm script runs Prettier over the file afterwards, so it is formatted as
 * every other committed file is and `format:check` has nothing to say. That is
 * also why `lib/api/openapi.test.ts` compares the committed file with the
 * builder as parsed documents rather than as bytes: Prettier's line breaks are
 * not part of the contract.
 *
 * Committed rather than generated in CI, because the app's developers, their
 * mock server and the SDK read the file from the repository, and a reviewer
 * should see a contract change as a diff in the pull request that makes it.
 */

const target = fileURLToPath(new URL('../docs/myblu-api.openapi.json', import.meta.url));

writeFileSync(target, `${JSON.stringify(openApiDocument(), null, 2)}\n`);
console.log(`wrote ${target}`);
