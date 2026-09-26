#!/usr/bin/env node
/**
 * The rules from AGENTS.md that a machine can check, checked by a machine.
 *
 * Everything here used to be a sentence asking a human or an agent to remember
 * something across a whole session — "declare the variable in render.yaml too",
 * "register the handler", "never read shipments.data from a page". Those are
 * exactly the instructions that get followed for a month and then missed once,
 * and several of them have already been missed once: §6.38 (the tracking payload
 * that must not reach a public page), §6.26 and §6.29 (3,888 Instagram
 * deliveries lost to a credential nobody had declared in two places).
 *
 * A rule that lives only in prose is enforced by whoever last read the prose.
 * A rule here is enforced on every pull request.
 *
 * Every check runs even after one fails, and every violation is printed — an
 * agent fixing these gets the whole list in one pass instead of one item per
 * push. Each rule carries the reason it exists, because a check whose purpose
 * nobody remembers gets deleted the first time it is inconvenient.
 */

import { fail, failures } from './lib.mjs';
import { checkEnvParity } from './rules/env-parity.mjs';
import { checkRenderGroups } from './rules/render-groups.mjs';
import { checkJobRegistry } from './rules/job-registry.mjs';
import { checkPostMigrationSql } from './rules/db-sql.mjs';
import { checkNoForceRls } from './rules/force-rls.mjs';
import { checkShipmentPayloadConfinement } from './rules/shipment-payload.mjs';
import { checkServerActions } from './rules/server-actions.mjs';
import { checkSanitiserConfinement } from './rules/sanitiser.mjs';
import { checkArticleNormalisation } from './rules/article-normalisation.mjs';
import { checkSlugConfinement } from './rules/slugify.mjs';
import { checkNoDomTitleAttribute } from './rules/dom-title.mjs';
import { checkLikePatternsUseTheBuilder } from './rules/like-patterns.mjs';
import { checkConsolePagesScroll } from './rules/console-scroll.mjs';
import { checkLightOnly } from './rules/light-only.mjs';
import { checkFramingHeaders } from './rules/framing.mjs';
import { checkNextAgentRulesOff } from './rules/next-agent-rules.mjs';
import { checkNoCommittedEnvFiles } from './rules/secrets.mjs';
import { checkInstructionSymlinks } from './rules/agents-symlinks.mjs';
import { checkMigrationsNotHandEdited } from './rules/generated-files.mjs';
import { checkFormSystemKeys } from './rules/form-system-keys.mjs';
import { checkAutomatedRepliesDoNotCountAsAgentReplies } from './rules/automated-reply-boundary.mjs';
import { checkClientBundleStaysOutOfTheDatabase } from './rules/client-bundle.mjs';
import { checkNoDeadExports } from './rules/dead-exports.mjs';

// ---------------------------------------------------------------------------

const RULES = [
  ['env-parity', checkEnvParity],
  ['render-groups', checkRenderGroups],
  ['job-registry', checkJobRegistry],
  // ---------------------------------------------------------------------------
  // SQL that Drizzle does not write
  //
  // db/sql/*.sql is replayed after every migration, so each file has to survive
  // being run again — and db/migrate.ts sends each file as one implicit
  // transaction, which CREATE INDEX CONCURRENTLY cannot run inside.
  //
  // The database job in CI proves idempotency by actually replaying these files.
  // These checks are the cheap half: they name the offending line instead of
  // handing back a Postgres error from the middle of a 500-line file.
  // ---------------------------------------------------------------------------
  ['db-sql', checkPostMigrationSql],
  ['force-rls', checkNoForceRls],
  ['shipment-payload', checkShipmentPayloadConfinement],
  // ---------------------------------------------------------------------------
  // Source conventions that are one grep away from being enforced
  // ---------------------------------------------------------------------------
  ['server-actions', checkServerActions],
  ['sanitiser', checkSanitiserConfinement],
  ['article-normalisation', checkArticleNormalisation],
  ['slugify', checkSlugConfinement],
  ['dom-title', checkNoDomTitleAttribute],
  ['like-patterns', checkLikePatternsUseTheBuilder],
  ['console-scroll', checkConsolePagesScroll],
  ['light-only', checkLightOnly],
  ['framing', checkFramingHeaders],
  ['next-agent-rules', checkNextAgentRulesOff],
  ['secrets', checkNoCommittedEnvFiles],
  ['agents-symlinks', checkInstructionSymlinks],
  ['generated-files', checkMigrationsNotHandEdited],
  ['form-system-keys', checkFormSystemKeys],
  ['automated-reply-boundary', checkAutomatedRepliesDoNotCountAsAgentReplies],
  ['client-bundle', checkClientBundleStaysOutOfTheDatabase],
  ['dead-exports', checkNoDeadExports],
];

for (const [name, run] of RULES) {
  try {
    run();
  } catch (error) {
    fail(
      name,
      '(check itself)',
      `the check threw, which usually means the file it reads changed shape: ${error.message}`,
    );
  }
}

if (failures.length === 0) {
  console.log(`repo rules: ${RULES.length} checks, no violations.`);
  process.exit(0);
}

console.error(`\nrepo rules: ${failures.length} violation(s).\n`);
for (const { rule, where, message } of failures) {
  console.error(`  [${rule}] ${where}`);
  console.error(`      ${message}\n`);
}
console.error('Each of these is a rule from AGENTS.md. If one is wrong, change the rule');
console.error('in scripts/ci/rules/ and say why in the same commit.\n');
process.exit(1);
