import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, fail, read, stripComments } from '../lib.mjs';

/**
 * `next dev` does not write into AGENTS.md.
 *
 * When Next 16.3's dev server detects an AI coding agent it upserts a managed
 * "agent rules" block into AGENTS.md on every start, and the block tells the
 * agent that committing it keeps the tree clean. AGENTS.md is this repo's
 * curated instructions — CLAUDE.md and the Copilot file are symlinks to it — so
 * the opt-out in next.config.ts is the only thing between every agent session
 * and a dirty tree whose easiest resolution is committing text nobody here
 * wrote. It is one line a tidy could drop.
 *
 * Two halves, because it can be lost two ways. The line can go from our
 * config; or a Next upgrade can rename the key, which Next's own config schema
 * only warns about, and then the line is present and does nothing. So the
 * installed Next must still declare the option. The repo-rules job installs
 * dependencies first, and so must anybody running this by hand.
 */
export function checkNextAgentRulesOff() {
  const rule = 'next-agent-rules';
  if (!/^\s*agentRules:\s*false,?\s*$/m.test(stripComments(read('next.config.ts')))) {
    fail(
      rule,
      'next.config.ts',
      '`agentRules: false` is gone — `next dev` will append its own block to AGENTS.md on every start in an agent session',
    );
  }

  const declaration = 'node_modules/next/dist/server/config-shared.d.ts';
  if (!existsSync(path.join(ROOT, declaration))) {
    fail(rule, declaration, 'not found — run `npm install` before this script');
    return;
  }
  if (!/\bagentRules\?:\s*boolean/.test(read(declaration))) {
    fail(
      rule,
      declaration,
      'the installed Next no longer declares `agentRules`, so the opt-out in next.config.ts may be dead — find what replaced it before upgrading',
    );
  }
}
