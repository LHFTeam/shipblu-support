import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isolatedGitEnv } from './git-env.mjs';
import { many, registeredCheck, runRule } from './fixture.mjs';

/**
 * The fixture is what every rule test stands on, so the two ways it could
 * quietly test the wrong thing are tested here: calling something other than
 * the function CI runs, and reading or writing a repository other than the one
 * it built.
 */

describe('registeredCheck', () => {
  it('finds the check when an exported constant sorts ahead of it', () => {
    const ran = vi.fn();
    // Namespace keys come out sorted: ACTION, ZED, checkA. The first export is
    // a string, which is what the fixture used to call.
    const ruleModule = { ACTION: 'a', ZED: 'z', checkA: ran };
    expect(Object.keys(ruleModule)[0]).toBe('ACTION');

    registeredCheck('fake', ruleModule, "const RULES = [\n  ['fake', checkA],\n];")();

    expect(ran).toHaveBeenCalledOnce();
  });

  it('refuses a rule the RULES table does not name', () => {
    expect(() => registeredCheck('fake', { checkA() {} }, 'const RULES = [];')).toThrow(
      /no RULES entry named 'fake'/,
    );
  });

  it('refuses when the table names a function the module does not export', () => {
    expect(() => registeredCheck('fake', { ACTION: 'a', checkB() {} }, "['fake', checkA]")).toThrow(
      /runs checkA for 'fake', but rules\/fake\.mjs exports no function/,
    );
  });

  it('resolves a real rule to the function repo-rules.mjs registers', async () => {
    const ruleModule = await import('./rules/console-scroll.mjs');
    expect(registeredCheck('console-scroll', ruleModule)).toBe(ruleModule.checkConsolePagesScroll);
  });
});

describe('runRule under an inherited GIT_DIR', () => {
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: isolatedGitEnv() });
  let other;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (other) rmSync(other, { recursive: true, force: true });
  });

  it('sees only the fixture, and leaves the other repository alone', async () => {
    // What a git hook hands its children: a GIT_DIR and index for some other
    // repository — here one holding a console page that would fail the rule.
    other = mkdtempSync(path.join(tmpdir(), 'repo-rules-other-'));
    git(other, 'init', '-q');
    mkdirSync(path.join(other, 'app/(console)/elsewhere'), { recursive: true });
    writeFileSync(path.join(other, 'app/(console)/elsewhere/page.tsx'), '<div />\n');
    git(other, 'add', '-A');
    const before = git(other, 'ls-files');

    vi.stubEnv('GIT_DIR', path.join(other, '.git'));
    vi.stubEnv('GIT_INDEX_FILE', path.join(other, '.git', 'index'));

    const found = await runRule('console-scroll', {
      ...many(
        8,
        (i) => `app/(console)/area${i}/page.tsx`,
        () => '<div className="overflow-y-auto" />\n',
      ),
      'app/(console)/mine/page.tsx': '<div className="p-6" />\n',
    });

    expect(found.map((f) => f.where)).toEqual(['app/(console)/mine/page.tsx']);
    expect(git(other, 'ls-files')).toBe(before);
  });
});
