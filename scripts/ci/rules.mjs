/**
 * Every rule `repo-rules.mjs` runs, paired with the name its violations carry.
 *
 * The table lives apart from the runner so it can be imported without running
 * anything: `repo-rules.mjs` runs every check and calls `process.exit` at the
 * top level, which is right for CI and fatal for a test. The rule fixture
 * (`fixture.mjs`) imports this module and looks an entry up by its name, so a
 * fixture always calls the very function CI calls — however the entry spells
 * it, aliased on import or wrapped in a closure — rather than one it had to
 * guess by reading this file's source.
 *
 * Importing this module imports every rule, and every rule imports `lib.mjs`,
 * which reads the repository root and the tracked-file list once, at load. A
 * caller pointing the rules at another repository (`REPO_RULES_ROOT`) must
 * therefore import it fresh after setting that, as the fixture does.
 */

import { checkEnvParity } from './rules/env-parity.mjs';
import { checkRenderGroups } from './rules/render-groups.mjs';
import { checkJobRegistry } from './rules/job-registry.mjs';
import { checkDbJobs } from './rules/db-jobs.mjs';
import { checkPostMigrationSql } from './rules/db-sql.mjs';
import { checkNoForceRls } from './rules/force-rls.mjs';
import { checkShipmentPayloadConfinement } from './rules/shipment-payload.mjs';
import { checkCredentialConfinement } from './rules/credential-confinement.mjs';
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
import { checkPagesDoNotImportTheDatabase } from './rules/page-db.mjs';
import { checkFormsDoNotReset } from './rules/form-reset.mjs';

export const RULES = [
  ['env-parity', checkEnvParity],
  ['render-groups', checkRenderGroups],
  ['job-registry', checkJobRegistry],
  ['db-jobs', checkDbJobs],
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
  ['credential-confinement', checkCredentialConfinement],
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
  ['form-reset', checkFormsDoNotReset],
  ['page-db', checkPagesDoNotImportTheDatabase],
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
