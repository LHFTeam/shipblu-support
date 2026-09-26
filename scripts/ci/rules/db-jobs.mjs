import { fail, jobTypes, read, requireAtLeast } from '../lib.mjs';

const LIST = 'scripts/ci/db-jobs.txt';

/**
 * Every job type is either run by CI's `database` job or skipped with a reason.
 *
 * The job exists because a query Postgres rejects passes every static check —
 * `backfill_meta_profiles` shipped green and died on its first real run — and
 * it only helps for the handlers it runs. The list used to be a loop in
 * ci.yml, and a job type added since was simply not in it: nothing said so,
 * and `sync_stale_shipments`, which needs neither network nor credential, had
 * never been run there. Holding the list to the `JobType` union makes a new
 * type a decision: run it, or write down why it cannot be.
 *
 * The file is only worth checking if CI reads it, so that is checked too.
 */
export function checkDbJobs() {
  const rule = 'db-jobs';

  const types = jobTypes();
  if (!types) {
    fail(rule, 'lib/queue/index.ts', 'could not find the JobType union');
    return;
  }

  const seen = new Map();
  let run = 0;
  read(LIST)
    .split('\n')
    .forEach((line, index) => {
      const where = `${LIST}:${index + 1}`;
      if (line.trim() === '' || line.startsWith('#')) return;

      const entry = line.match(/^(run|skip): ([a-z_]+)(.*)$/);
      if (!entry) {
        fail(rule, where, 'each line is `run: <type> [key=value ...]` or `skip: <type> — <why>`');
        return;
      }
      const [, kind, type, rest] = entry;

      if (!types.includes(type)) {
        fail(rule, where, `"${type}" is not a JobType — a rename left this behind`);
      }
      if (seen.has(type)) {
        fail(rule, where, `"${type}" is already listed on line ${seen.get(type)}`);
      }
      seen.set(type, index + 1);

      if (kind === 'run') {
        run += 1;
        if (rest !== '' && !/^( [A-Za-z]+=[^\s]+)+$/.test(rest)) {
          fail(rule, where, 'a run line takes only key=value arguments after the type');
        }
      } else if (!/^ — \S/.test(rest)) {
        fail(rule, where, `"${type}" is skipped without saying why — write the reason after " — "`);
      }
    });

  for (const type of types) {
    if (!seen.has(type)) {
      fail(
        rule,
        LIST,
        `job type "${type}" is neither run nor skipped — add \`run: ${type}\` if its handler needs no network or credential, or \`skip: ${type} — <why>\``,
      );
    }
  }

  requireAtLeast(rule, LIST, run, 10, 'job types run against Postgres');

  if (!read('.github/workflows/ci.yml').includes(LIST)) {
    fail(rule, '.github/workflows/ci.yml', `the database job no longer reads ${LIST}`);
  }
}
