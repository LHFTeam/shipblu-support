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
  it('returns the function the table pairs with the name', () => {
    const ran = vi.fn();
    registeredCheck('fake', [
      ['other', () => {}],
      ['fake', ran],
    ])();
    expect(ran).toHaveBeenCalledOnce();
  });

  it('matches the name exactly, metacharacters included', () => {
    // Read as a pattern, 'a.b' matches 'axb' — the source-parsing lookup would
    // have run the neighbouring rule.
    expect(() => registeredCheck('a.b', [['axb', () => {}]])).toThrow(/no entry named 'a\.b'/);
  });

  it('refuses a rule the RULES table does not name', () => {
    expect(() => registeredCheck('fake', [])).toThrow(/no entry named 'fake'/);
  });

  it('refuses an entry that is not a function', () => {
    expect(() => registeredCheck('fake', [['fake', 'checkA']])).toThrow(/is not a function/);
  });

  it('resolves a real rule to the function repo-rules.mjs runs', async () => {
    const { RULES } = await import('./rules.mjs');
    const ruleModule = await import('./rules/console-scroll.mjs');
    expect(registeredCheck('console-scroll', RULES)).toBe(ruleModule.checkConsolePagesScroll);
  });
});

describe('runRule with an entry that does not name the rule module export', () => {
  const pages = {
    ...many(
      8,
      (i) => `app/(console)/area${i}/page.tsx`,
      () => '<div className="overflow-y-auto" />\n',
    ),
    'app/(console)/mine/page.tsx': '<div className="p-6" />\n',
  };
  // Imported inside the fixture's reset, the way rules.mjs is, so the check
  // reads the fixture rather than this repository.
  const table = async () => {
    const { checkConsolePagesScroll: aliased } = await import('./rules/console-scroll.mjs');
    return {
      RULES: [
        ['aliased', aliased],
        ['wrapped', () => aliased()],
      ],
    };
  };

  it.each(['aliased', 'wrapped'])('runs a %s entry against the fixture', async (rule) => {
    const found = await runRule(rule, pages, { loadTable: table });
    expect(found.map((f) => f.where)).toEqual(['app/(console)/mine/page.tsx']);
  });
});

describe('runRule with a check that throws', () => {
  it('records the failure CI records instead of rejecting', async () => {
    const table = async () => ({
      RULES: [
        [
          'breaks',
          () => {
            throw new Error('the file changed shape');
          },
        ],
      ],
    });

    await expect(runRule('breaks', {}, { loadTable: table })).resolves.toEqual([
      {
        rule: 'breaks',
        where: '(check itself)',
        message:
          'the check threw, which usually means the file it reads changed shape: the file changed shape',
      },
    ]);
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
