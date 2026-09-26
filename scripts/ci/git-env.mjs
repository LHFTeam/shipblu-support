/**
 * The environment for a git command that must act on the repository at `cwd`
 * and nowhere else.
 *
 * git takes GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE over the directory it is
 * run in, and a git hook exports them. So a rule test started from a hook, or
 * with GIT_DIR left in the shell, would read — and `git add` would write — the
 * index those name rather than the fixture's. The object and common
 * directories are dropped for the same reason: they point git at another
 * repository's storage.
 *
 * Shared by the fixture that builds the repository and by `git()` in
 * `lib.mjs`, which every rule asks git through — the file list and a rule's
 * diff alike — so none of them can be pointed at a different repository.
 */
const REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
];

export function isolatedGitEnv() {
  const env = { ...process.env };
  for (const name of REPOSITORY_VARIABLES) delete env[name];
  return env;
}
