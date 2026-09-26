import { describe, expect, it } from 'vitest';
import { runRule } from '../fixture.mjs';

/**
 * Every JobType is run by the database job or skipped with a reason, and CI
 * reads the list — so a new job type cannot miss the database job silently.
 */

const TYPES = Array.from({ length: 10 }, (_, i) => `sweep_${String.fromCharCode(97 + i)}`);

const queue = (types) => `export type JobType =\n${types.map((t) => `  | '${t}'`).join('\n')};\n`;

const REPO = {
  'lib/queue/index.ts': queue([...TYPES, 'send_email']),
  '.github/workflows/ci.yml': 'run: sed -n "s/^run: //p" scripts/ci/db-jobs.txt\n',
  'scripts/ci/db-jobs.txt': [
    '# header',
    '',
    ...TYPES.map((t, i) => (i === 0 ? `run: ${t} limit=1 dryRun=true` : `run: ${t}`)),
    'skip: send_email — needs a message to send, and sends it',
    '',
  ].join('\n'),
};

const withList = (lines) => ({ ...REPO, 'scripts/ci/db-jobs.txt': lines.join('\n') + '\n' });
const RUN_ALL = TYPES.map((t) => `run: ${t}`);

describe('db-jobs', () => {
  it('passes when every job type is run or skipped with a reason', async () => {
    expect(await runRule('db-jobs', REPO)).toEqual([]);
  });

  it('refuses a job type the list does not mention', async () => {
    const found = await runRule('db-jobs', withList(RUN_ALL));

    expect(found).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/"send_email" is neither run nor skipped/),
      }),
    ]);
  });

  it('refuses a name that is not a job type', async () => {
    const found = await runRule(
      'db-jobs',
      withList([...RUN_ALL, 'skip: send_email — sends', 'run: renamed_away']),
    );

    expect(found).toEqual([
      expect.objectContaining({
        where: 'scripts/ci/db-jobs.txt:12',
        message: expect.stringMatching(/"renamed_away" is not a JobType/),
      }),
    ]);
  });

  it('refuses a job type listed twice', async () => {
    const found = await runRule(
      'db-jobs',
      withList([...RUN_ALL, 'skip: send_email — sends', 'skip: sweep_a — twice']),
    );

    expect(found).toEqual([
      expect.objectContaining({
        where: 'scripts/ci/db-jobs.txt:12',
        message: expect.stringMatching(/already listed on line 1/),
      }),
    ]);
  });

  it('refuses a skip that does not say why', async () => {
    const found = await runRule('db-jobs', withList([...RUN_ALL, 'skip: send_email']));

    expect(found).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/skipped without saying why/) }),
    ]);
  });

  it('refuses a line in neither shape', async () => {
    const found = await runRule(
      'db-jobs',
      withList([...RUN_ALL, 'skip: send_email — sends', 'sweep_a']),
    );

    expect(found).toEqual([
      expect.objectContaining({
        where: 'scripts/ci/db-jobs.txt:12',
        message: expect.stringMatching(/each line is/),
      }),
    ]);
  });

  it('refuses a list CI no longer reads', async () => {
    const found = await runRule('db-jobs', { ...REPO, '.github/workflows/ci.yml': 'run: true\n' });

    expect(found).toEqual([
      expect.objectContaining({
        where: '.github/workflows/ci.yml',
        message: expect.stringMatching(/no longer reads/),
      }),
    ]);
  });

  it('does not count a comment that names the list as CI reading it', async () => {
    const found = await runRule('db-jobs', {
      ...REPO,
      '.github/workflows/ci.yml': [
        '      # Which jobs is scripts/ci/db-jobs.txt.',
        '      - run: for job in sweep_a; do npm run job -- $job; done',
        '',
      ].join('\n'),
    });

    expect(found).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/no longer reads/) }),
    ]);
  });

  it('refuses a run argument the shell would glob', async () => {
    const found = await runRule(
      'db-jobs',
      withList([...RUN_ALL.slice(1), 'run: sweep_a limit=*', 'skip: send_email — sends']),
    );

    expect(found).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/without glob characters/) }),
    ]);
  });

  it('fails when it runs too few job types to be checking anything', async () => {
    const found = await runRule('db-jobs', {
      ...REPO,
      'lib/queue/index.ts': queue(['sweep_a', 'send_email']),
      'scripts/ci/db-jobs.txt': 'run: sweep_a\nskip: send_email — sends\n',
    });

    expect(found).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/found only 1 job types run against Postgres/),
      }),
    ]);
  });
});
