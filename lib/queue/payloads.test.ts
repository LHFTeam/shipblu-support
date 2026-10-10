import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { enqueue, PermanentJobError, type ClaimedJob } from '@/lib/queue';
import { JOB_PAYLOADS, parseJobPayload } from './payloads';

function job(payload: Record<string, unknown>): ClaimedJob {
  return { id: 'job-1', type: 'send_email', payload } as unknown as ClaimedJob;
}

describe('parseJobPayload', () => {
  it('hands back the fields its schema declares, and drops the rest', () => {
    expect(parseJobPayload(job({ messageId: 'm-1', stray: true }), 'send_email')).toEqual({
      messageId: 'm-1',
    });
  });

  it('fails a payload no retry can fix for good, naming the job and the field', () => {
    const run = () => parseJobPayload(job({ messageId: 42 }), 'send_email');

    expect(run).toThrow(PermanentJobError);
    expect(run).toThrow(/^send_email: invalid payload — .*"messageId"/s);
  });

  it('reads a missing payload field as invalid, not as undefined', () => {
    expect(() => parseJobPayload(job({}), 'send_whatsapp')).toThrow(PermanentJobError);
  });
});

describe('the inbound family', () => {
  const parse = (type: Parameters<typeof parseJobPayload>[1], payload: Record<string, unknown>) =>
    parseJobPayload(job(payload), type);

  it('reads a Meta attachment and a WhatsApp one as the two halves of download_media', () => {
    expect(
      parse('download_media', { source: 'meta', messageId: 'm-1', url: 'https://cdn.example/a' }),
    ).toEqual({ source: 'meta', messageId: 'm-1', url: 'https://cdn.example/a' });
    expect(parse('download_media', { messageId: 'm-1', mediaId: 'wa-1' })).toEqual({
      messageId: 'm-1',
      mediaId: 'wa-1',
    });
  });

  it('refuses a Meta attachment with no URL rather than reading it as WhatsApp media', () => {
    expect(() =>
      parse('download_media', { source: 'meta', messageId: 'm-1', mediaId: 'wa-1' }),
    ).toThrow(PermanentJobError);
  });

  it('turns a tracking number typed at `npm run job` back into the string it was', () => {
    expect(parse('sync_shipment', { trackingNumber: 1755021358719 })).toEqual({
      trackingNumber: '1755021358719',
    });
  });

  it('refuses a sync that names no shipment', () => {
    expect(() => parse('sync_shipment', { force: true })).toThrow(
      /requires a shipmentId or a trackingNumber/,
    );
  });

  it('refuses a moderation nobody can perform', () => {
    expect(() => parse('moderate_meta_comment', { messageId: 'm-1', action: 'pin' })).toThrow(
      PermanentJobError,
    );
    expect(
      parse('moderate_meta_comment', { messageId: 'm-1', action: 'hide', agentId: null }),
    ).toEqual({ messageId: 'm-1', action: 'hide', agentId: null });
  });

  // Recorded, and said in the PR: before the schema, `force=yes` was read as
  // `force !== true` and ran without forcing. Now it is refused, and nothing runs.
  it('takes force only as a boolean', () => {
    const profile = { contactId: 'c-1', platform: 'instagram', userId: 'u-1' };
    expect(parse('fetch_meta_profile', { ...profile, force: true })).toEqual({
      ...profile,
      force: true,
    });
    expect(() => parse('fetch_meta_profile', { ...profile, force: 'yes' })).toThrow(
      PermanentJobError,
    );
  });
});

describe('the hand-run options', () => {
  const parse = (type: Parameters<typeof parseJobPayload>[1], payload: Record<string, unknown>) =>
    parseJobPayload(job(payload), type);

  // The cron and the bare `npm run job -- <type>` both send no options at all.
  it.each(['backfill_meta_profiles', 'sync_stale_shipments', 'rollup_metrics'] as const)(
    'takes an empty %s payload, which is the default run',
    (type) => {
      expect(parse(type, {})).toEqual({});
    },
  );

  it('takes the values `npm run job` makes of what an operator typed', () => {
    expect(parse('backfill_meta_profiles', { force: true, limit: 50 })).toEqual({
      force: true,
      limit: 50,
    });
    expect(parse('sync_stale_shipments', { staleMinutes: 60 })).toEqual({ staleMinutes: 60 });
    expect(parse('rollup_metrics', { from: '2026-09-01', to: '2026-09-20' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-20',
    });
  });

  // Recorded, and said in the PR: each of these used to be read as absent, and
  // absent is the default — a real run over the whole archive.
  it.each([
    ['backfill_meta_profiles', { limit: 'abc' }],
    ['backfill_meta_profiles', { limit: 0 }],
    ['sync_stale_shipments', { limit: -1 }],
    ['sync_stale_shipments', { staleMinutes: 'hourly' }],
    ['rollup_metrics', { day: '2026-9-1' }],
    ['rollup_metrics', { days: 0 }],
  ] as const)('refuses %s %o rather than running the default', (type, payload) => {
    expect(() => parse(type, payload)).toThrow(PermanentJobError);
  });

  // A key the schema does not know was dropped, and the default ran: the typo
  // in `limt=50` walked every contact.
  it.each([
    ['backfill_meta_profiles', { limt: 50 }],
    ['sync_stale_shipments', { stale_minutes: 60 }],
    ['rollup_metrics', { form: '2026-09-01' }],
    ['sync_shipment', { shipmentId: 's-1', forse: true }],
  ] as const)('refuses %s %o, a key it does not know', (type, payload) => {
    expect(() => parse(type, payload)).toThrow(PermanentJobError);
  });
});

describe('the backfills and the knowledge-base passes', () => {
  const parse = (type: Parameters<typeof parseJobPayload>[1], payload: Record<string, unknown>) =>
    parseJobPayload(job(payload), type);

  // What CI's database job and the admin buttons send, and the bare run.
  it.each([
    ['backfill_shipment_links', {}],
    ['backfill_shipment_links', { limit: 1 }],
    ['backfill_message_locations', { limit: 1 }],
    ['backfill_categorise_ai', { dryRun: true, limit: 1 }],
    ['normalise_kb_formatting', { dryRun: true }],
    ['seed_console_handbook', {}],
    ['seed_console_handbook', { overwrite: true }],
    ['seed_canned_responses', { dryRun: true }],
    ['seed_canned_responses', { dryRun: true, overwrite: true }],
    ['seed_canned_responses', { overwrite: true, keys: 'finance.cod_limit,delivery.hours' }],
  ] as const)('takes %s %o', (type, payload) => {
    expect(parse(type, payload)).toEqual(payload);
  });

  // Recorded, and said in the PR: each of these used to do a real run.
  it.each([
    'backfill_shipment_links',
    'backfill_message_locations',
    'backfill_categorise_ai',
    'normalise_kb_formatting',
    'seed_console_handbook',
    'seed_canned_responses',
  ] as const)('refuses a %s dryRun that is not a boolean, rather than writing', (type) => {
    expect(() => parse(type, { dryRun: 1 })).toThrow(PermanentJobError);
    expect(() => parse(type, { dryRun: 'yes' })).toThrow(PermanentJobError);
  });

  it('takes a scan bound Date can read, and refuses one it would misread', () => {
    expect(parse('backfill_shipment_links', { since: '2026-09-01' })).toEqual({
      since: '2026-09-01',
    });
    expect(parse('backfill_message_locations', { until: '2026-09-20T12:00:00Z' })).toEqual({
      until: '2026-09-20T12:00:00Z',
    });
    // `since=20260901` at the command line: a number, milliseconds into 1970.
    expect(() => parse('backfill_shipment_links', { since: 20260901 })).toThrow(PermanentJobError);
    expect(() => parse('backfill_categorise_ai', { until: 'yesterday' })).toThrow(
      PermanentJobError,
    );
  });

  // Review on #252: a misspelt option was dropped, and the job ran for real.
  it('refuses an option it does not know, so a misspelt dryRun does not write', () => {
    expect(() => parse('normalise_kb_formatting', { dryrun: true })).toThrow(PermanentJobError);
    expect(() => parse('seed_console_handbook', { overWrite: true })).toThrow(PermanentJobError);
    // The one option here with no undo: a misspelt dryRun beside it must not
    // turn a preview into the run that replaces the team's edits.
    expect(() => parse('seed_canned_responses', { overwrite: true, dryrun: true })).toThrow(
      PermanentJobError,
    );
  });

  // Review on #344: re-run by hand after a failure, and a dropped dryRun wrote.
  it('refuses a classify_priority option it does not have, since there is no dry run', () => {
    const messageId = '00000000-0000-4000-8000-000000000001';
    expect(parse('classify_priority', { messageId })).toEqual({ messageId });
    expect(() => parse('classify_priority', { messageId, dryRun: true })).toThrow(
      PermanentJobError,
    );
  });

  it('keeps a run label of digits as the text it was typed as', () => {
    expect(parse('backfill_categorise_ai', { runLabel: 2026 })).toEqual({ runLabel: '2026' });
  });

  it('takes only a locale the help centre has', () => {
    expect(parse('normalise_kb_formatting', { locale: 'ar' })).toEqual({ locale: 'ar' });
    expect(() => parse('normalise_kb_formatting', { locale: 'fr' })).toThrow(PermanentJobError);
  });
});

// Never called: `tsc` is the assertion. Each line below the directive must fail
// to compile, and would compile if `enqueue` were typed `Record<string, unknown>`.
async function enqueueIsTypedFromTheSchema(messageId: string) {
  await enqueue('send_email', { messageId });
  await enqueue('cleanup', {});
  // @ts-expect-error a send without the message it sends
  await enqueue('send_email', {});
  // @ts-expect-error an id of the wrong type
  await enqueue('send_whatsapp', { messageId: 42 });
  // @ts-expect-error the payload of another job
  await enqueue('send_agent_invite', { messageId });
  // @ts-expect-error a profile on a platform that has none
  await enqueue('fetch_meta_profile', { contactId: 'c', platform: 'email', userId: 'u' });
  // @ts-expect-error a moderation that does not exist
  await enqueue('moderate_meta_comment', { messageId, action: 'pin' });
}
void enqueueIsTypedFromTheSchema;

describe('complete_coexistence_onboarding', () => {
  const parse = (payload: Record<string, unknown>) =>
    parseJobPayload(
      { ...job(payload), type: 'complete_coexistence_onboarding' } as ClaimedJob,
      'complete_coexistence_onboarding',
    );
  const id = '7d1f4c1e-0000-4000-8000-000000000001';

  it('reads steps typed at `npm run job` as a comma-separated list', () => {
    expect(parse({ onboardingId: id, steps: 'contacts, history' })).toEqual({
      onboardingId: id,
      steps: ['contacts', 'history'],
    });
    expect(parse({ onboardingId: id, steps: ['history'] })).toEqual({
      onboardingId: id,
      steps: ['history'],
    });
  });

  /** A dropped `step=history` would run every step instead of one. */
  it('refuses a step it does not know and a key it does not know', () => {
    expect(() => parse({ onboardingId: id, steps: 'histroy' })).toThrow(PermanentJobError);
    expect(() => parse({ onboardingId: id, step: 'history' })).toThrow(PermanentJobError);
    expect(() => parse({ onboardingId: 'not-a-uuid' })).toThrow(PermanentJobError);
  });
});

/**
 * No job payload may carry a credential under a name that says it is one.
 *
 * `jobs.payload` is jsonb in a table anyone with the database can read — a
 * dump, a backup, `execute_sql` from a tool — and a row outlives its job: one
 * that reached `dead` is never cleaned up. The stored WhatsApp credential is
 * sealed so that nobody reading the database holds anything usable, and a
 * payload that carried the token across the queue "so the worker need not
 * look it up" would undo that in a column nobody thinks of as storage. An
 * action that needs the token enqueues an id, and the worker resolves it.
 *
 * A check of names, not values: a secret under an innocent name passes. What
 * it stops is the honest version of the mistake, in the commit that writes
 * the schema, before any row exists to clean up.
 */
describe('no job payload carries a credential', () => {
  const SECRET_SHAPED = /token|secret|envelope|ciphertext|password|api[_-]?key/i;
  const isSecretShaped = (path: string) => SECRET_SHAPED.test(path.split('.').at(-1)!);

  type Schema = z.core.$ZodType;

  function isSchema(value: unknown): value is Schema {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { _zod?: { def?: { type?: unknown } } })._zod?.def?.type === 'string'
    );
  }

  /**
   * Every object key reachable in `schema`, as a dotted path.
   *
   * Generic over zod's definitions rather than a switch over the kinds the
   * payloads use today. Every child a definition holds — a union's options, an
   * optional's inner type, both ends of a pipe (what `preprocess` and
   * `transform` build), an array's element, an object's catchall — is a
   * property of `_zod.def` that is itself a schema or an array of them, so a
   * kind used for the first time later is walked without anybody adding it
   * here. Only an object's `shape` names keys. A check — `min`, `.refine` —
   * is not a schema (its definition has no `type`) and is passed over: a
   * refined object is still an object, with its shape where it was.
   */
  function keysIn(schema: Schema, at = '', walking = new Set<Schema>()): string[] {
    // A lazy schema can name itself; one already on this path is a cycle.
    if (walking.has(schema)) return [];
    walking.add(schema);
    const def = schema._zod.def as unknown as Record<string, unknown>;
    const found: string[] = [];
    for (const [name, value] of Object.entries(def)) {
      if (def.type === 'object' && name === 'shape') {
        for (const [key, child] of Object.entries(value as Record<string, Schema>)) {
          found.push(`${at}${key}`, ...keysIn(child, `${at}${key}.`, walking));
        }
        continue;
      }
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isSchema(child)) found.push(...keysIn(child, at, walking));
      }
    }
    // The one child held behind a function rather than as a value.
    if (def.type === 'lazy') found.push(...keysIn((def.getter as () => Schema)(), at, walking));
    walking.delete(schema);
    return found;
  }

  it('walks a schema all the way down, so the check below cannot pass by seeing nothing', () => {
    const synthetic = z
      .strictObject({
        messageId: z.string(),
        source: z.union([
          z.object({ url: z.string() }),
          z.object({ media: z.array(z.object({ accessToken: z.string() })).optional() }),
        ]),
        options: z.preprocess((value) => value, z.object({ api_key: z.string() })).optional(),
        later: z.lazy(() => z.object({ envelope: z.string() })),
      })
      .refine(() => true);

    expect(keysIn(synthetic).filter(isSecretShaped)).toEqual([
      'source.media.accessToken',
      'options.api_key',
      'later.envelope',
    ]);
  });

  it('finds no secret-shaped key in any job payload', () => {
    const keys = new Map<string, string[]>(
      Object.entries(JOB_PAYLOADS).map(([type, schema]) => [type, [...new Set(keysIn(schema))]]),
    );

    // The reach is real, through every shape `JOB_PAYLOADS` holds: a plain
    // object, both branches of a union, an object behind `.refine`, a field
    // behind a `preprocess`.
    expect(keys.get('send_email')).toEqual(['messageId']);
    expect(keys.get('download_media')).toEqual(expect.arrayContaining(['url', 'mediaId']));
    expect(keys.get('sync_shipment')).toEqual(['shipmentId', 'trackingNumber', 'force']);
    expect(keys.get('complete_coexistence_onboarding')).toEqual(['onboardingId', 'steps']);

    const secretShaped = [...keys].flatMap(([type, paths]) =>
      paths.filter(isSecretShaped).map((path) => `${type}: ${path}`),
    );
    expect(secretShaped).toEqual([]);
  });
});
