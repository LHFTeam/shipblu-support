import { fail, read, requireAtLeast } from '../lib.mjs';

// ---------------------------------------------------------------------------
// The job registry
//
// AGENTS.md: "add the type to JobType in lib/queue/index.ts, a handler under
// worker/handlers/, and register it in worker/handlers/index.ts — an
// unregistered type fails loudly rather than being dropped."
//
// Failing loudly is the right runtime behaviour and it is still a job that died
// in production. The registry is a closed set known at build time, so the
// mismatch can be caught here instead.
//
// The third check is the one prose never covered: a Render cron that runs
// `npm run job -- <type>` for a type that does not exist. That is a cron service
// going red on a schedule, discovered whenever somebody next reads the dashboard.
// ---------------------------------------------------------------------------
export function checkJobRegistry() {
  const rule = 'job-registry';
  const queue = read('lib/queue/index.ts');
  const registry = read('worker/handlers/index.ts');

  const union = queue.match(/export type JobType =([\s\S]*?);/);
  if (!union) {
    fail(rule, 'lib/queue/index.ts', 'could not find the JobType union');
    return;
  }
  const types = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  if (
    !requireAtLeast(rule, 'lib/queue/index.ts', types.length, 10, 'job types in the JobType union')
  ) {
    return;
  }

  const handlersBlock = registry.match(
    /export const handlers: Partial<Record<JobType, JobHandler>> = \{([\s\S]*?)\n\};/,
  );
  if (!handlersBlock) {
    fail(rule, 'worker/handlers/index.ts', 'could not find the handlers map');
    return;
  }
  // Both `cleanup,` (shorthand) and `sla_sweep: () => ...` are registrations.
  const registered = [...handlersBlock[1].matchAll(/^\s{2}([a-z_]+)\s*[:,]/gm)].map((m) => m[1]);
  if (
    !requireAtLeast(rule, 'worker/handlers/index.ts', registered.length, 10, 'registered handlers')
  ) {
    return;
  }

  const plannedBlock = registry.match(/PLANNED_JOB_TYPES = new Set<JobType>\(\[([\s\S]*?)\]\)/);
  const planned = plannedBlock
    ? [...plannedBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    : [];

  for (const type of types) {
    if (!registered.includes(type) && !planned.includes(type)) {
      fail(
        rule,
        'worker/handlers/index.ts',
        `job type "${type}" has no handler and is not in PLANNED_JOB_TYPES — every enqueued job of this type will fail`,
      );
    }
  }
  for (const name of registered) {
    if (!types.includes(name)) {
      fail(
        rule,
        'worker/handlers/index.ts',
        `handler "${name}" is registered but is not a JobType — a rename left this behind`,
      );
    }
  }

  // Every cron in the blueprint has to name a job that exists.
  const yaml = read('render.yaml');
  for (const match of yaml.matchAll(/npm run job -- ([a-z_]+)/g)) {
    if (!types.includes(match[1])) {
      fail(
        rule,
        'render.yaml',
        `a cron runs \`npm run job -- ${match[1]}\`, which is not a JobType — that cron fails on every schedule`,
      );
    }
  }
}
