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

import { failures, runCheck } from './lib.mjs';
import { RULES } from './rules.mjs';

for (const [name, run] of RULES) runCheck(name, run);

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
