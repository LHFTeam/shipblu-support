import { statSync, readlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, fail } from '../lib.mjs';

/**
 * CLAUDE.md and .github/copilot-instructions.md are symlinks to AGENTS.md.
 *
 * Replacing one with a copy is silent and permanent: the copy stops being
 * updated, and the next agent reading it follows instructions that were correct
 * some months ago. AGENTS.md says a stale file is worse than none for exactly
 * this reason.
 */
export function checkInstructionSymlinks() {
  const rule = 'agents-symlinks';
  for (const [link, target] of [
    ['CLAUDE.md', 'AGENTS.md'],
    ['.github/copilot-instructions.md', '../AGENTS.md'],
  ]) {
    const full = path.join(ROOT, link);
    if (!existsSync(full)) {
      fail(rule, link, 'is missing');
      continue;
    }
    if (!statSync(full, { throwIfNoEntry: false })?.isFile() || !isSymlink(full)) {
      fail(
        rule,
        link,
        `must be a symlink to ${target}, not a copy — a copy stops being updated and the next agent follows stale instructions`,
      );
      continue;
    }
    const actual = readlinkSync(full);
    if (actual !== target) {
      fail(rule, link, `points at ${actual}, expected ${target}`);
    }
  }
}

function isSymlink(full) {
  try {
    readlinkSync(full);
    return true;
  } catch {
    return false;
  }
}
