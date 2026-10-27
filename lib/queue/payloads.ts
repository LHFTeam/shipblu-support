import { DateTime } from 'luxon';
import { z } from 'zod';
import { SURVEY_TRIGGERS } from '@/lib/csat/decision';
import { dayWindow, wallClockInstant } from '@/lib/hours/wall-clock';
import { TEAM_TIME_ZONE } from '@/lib/hours/zone';
import { LOCALES } from '@/lib/kb/locale';
import { CATEGORY_AI_LIVE_LABEL, RERUNNABLE_STEPS } from '@/db/schema';
import { PermanentJobError, type ClaimedJob, type JobType } from '@/lib/queue';

/**
 * A scan's bounds, typed as text and handed to the handler as instants read on
 * the team's clock. `since` is inclusive and `until` exclusive, so two runs that
 * share an instant, written to the millisecond, neither repeat nor skip the rows
 * on it. A date names a whole day at either end, so dates chain as
 * `until=2026-10-07` and then `since=2026-10-08`, as `rollup_metrics` days do.
 *
 * The handlers used to call `new Date()` on the text, which reads
 * `2026-10-01T00:00` in the host's zone and `2026-10-01` as UTC midnight. So one
 * command meant 00:00Z on Render, which sets no `TZ`, and 21:00Z the evening
 * before on a laptop in Cairo, and neither was the start of 1 October where the
 * team works and every report cuts its days (`docs/PROJECT-STATE.md` §6.102).
 * Read once here, a handler is given a `Date` and has nothing left to misread:
 *
 * - a time ending in `Z` or an offset is the instant it names;
 * - a time without one is that time in Cairo, through `wallClockInstant`;
 * - a date alone is that whole Cairo day, through `dayWindow`: `since` from its
 *   start, `until` to its end. `since=2026-10-01 until=2026-10-07` covers the
 *   7th, as `rollup_metrics from=2026-10-01 to=2026-10-07` does.
 *
 * Only those shapes, with a space allowed for the `T` as Postgres prints a
 * timestamp. `Date.parse` read anything else it could, `Oct 1 2026` in the
 * host's zone and `2026-02-30` as 2 March. A number never reaches here as text:
 * `npm run job` makes `since=20260901` a number, which `new Date` read as
 * milliseconds into 1970.
 */
function scanBound(side: 'since' | 'until') {
  return z.string().transform((text, ctx) => {
    const read = readBound(text, side);
    if (typeof read === 'string') {
      ctx.addIssue(read);
      return z.NEVER;
    }
    return read;
  });
}

const scanSince = scanBound('since');
const scanUntil = scanBound('until');

/**
 * A backfill's run label, which must carry a letter. `npm run job` reads
 * anything numeric as a number, and a number does not give back the text it
 * was typed as: `2026.10` comes back `2026.1` and `007` comes back `7`, so two
 * labels typed apart would be one, and a run meant to start a fresh label
 * would fill the gaps of an older one. Never `live`, the label the live
 * classifier writes and the only one settling and ownership read: a backfill
 * writing under it would decide live tickets.
 */
const backfillLabel = z
  .string({ error: 'a label needs a letter: npm run job reads digits as a number' })
  .transform((label) => label.trim())
  .refine((label) => label.length > 0, 'a label cannot be blank')
  .refine(
    (label) => label !== CATEGORY_AI_LIVE_LABEL,
    `"${CATEGORY_AI_LIVE_LABEL}" is the live classifier's label`,
  );

// Hours 00-23, so `T24:00` is not a second spelling of the next midnight, and
// an offset held to hours 00-23 and minutes 00-59, as `Date.parse` held it:
// luxon checks neither, and reads `+03:60` as +04:00.
const BOUND =
  /^(\d{4}-\d{2}-\d{2})(?:[T ]((?:[01]\d|2[0-3]):\d{2}(?::\d{2}(?:\.(\d+))?)?)(Z|[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?)?)?$/i;

const UNREADABLE =
  `expected 2026-10-01 or 2026-10-01T09:30 in ${TEAM_TIME_ZONE} time, ` +
  `or a time ending in Z or an offset such as +03:00`;

/** The instant `text` bounds a scan at, or the sentence refusing it. */
function readBound(text: string, side: 'since' | 'until'): Date | string {
  const parts = BOUND.exec(text);
  const date = parts?.[1];
  if (!parts || !date) return UNREADABLE;
  const [, , time, fraction = '', offset] = parts;

  if (!time) {
    const day = dayWindow(date, TEAM_TIME_ZONE);
    if (!day) return UNREADABLE;
    return side === 'since' ? day.start : day.end;
  }

  let at: Date | 'skipped' | null;
  if (offset) {
    const named = DateTime.fromISO(`${date}T${time}${offset}`, { zone: 'utc', setZone: true });
    at = named.isValid ? named.toJSDate() : null;
  } else {
    at = wallClockInstant(`${date}T${time}`, TEAM_TIME_ZONE);
  }
  if (at === null) return UNREADABLE;
  if (at === 'skipped') {
    return (
      `${TEAM_TIME_ZONE}'s clocks skipped ${text} when they went forward; ` +
      `give the offset it was meant at, or the date alone for that whole day`
    );
  }

  // A `Date` holds milliseconds, and luxon drops the digits past them, which
  // moves a bound earlier. That only widens `since`; it would narrow `until`,
  // so a bound pasted from a `created_at` stopped short of rows it named. Every
  // backfill here may see a row twice, so the millisecond after it is the
  // safe side, never the one before.
  return side === 'until' && /[1-9]/.test(fraction.slice(3)) ? new Date(at.getTime() + 1) : at;
}

/**
 * What a job's payload must hold, written once for the code that enqueues it
 * and the handler that reads it.
 *
 * `jobs.payload` is jsonb, so what a handler is handed is whatever somebody
 * wrote into the row: a caller, a hand-inserted replay, or `npm run job` with
 * its `key=value` arguments. Each handler used to check the fields it needed
 * in its own words — most with `typeof … !== 'string'` and a plain `Error`,
 * which the queue retries five times although no retry can supply a missing
 * id. Checked here, a payload that is wrong fails once, as a
 * `PermanentJobError` naming the field, and `enqueue` is typed from the same
 * schema, so a caller that sends the wrong shape does not compile.
 *
 * A job with no entry takes any object, as every job did before. Entries are
 * added a family at a time, each with its handlers switched over in the same
 * change.
 *
 * Exported for `payloads.test.ts`, which walks every schema for a key named
 * like a credential; nothing else reads it but `parseJobPayload` and the types
 * below.
 */
export const JOB_PAYLOADS = {
  send_email: z.object({ messageId: z.string() }),
  send_side_email: z.object({ messageId: z.string() }),
  send_whatsapp: z.object({ messageId: z.string() }),
  send_meta: z.object({ messageId: z.string() }),
  send_agent_invite: z.object({ inviteId: z.uuid() }),
  send_notification_email: z.object({
    to: z.email(),
    subject: z.string().min(1),
    textBody: z.string().min(1),
    htmlBody: z.string().min(1),
  }),

  process_webhook: z.object({ webhookEventId: z.string() }),
  // Enqueued by `enqueuePriorityClassification`, and re-run by hand with
  // `npm run job -- classify_priority messageId=…` after a `failed` run, whose
  // dedupe key is spent — so strict: `dryRun=true` is refused rather than
  // dropped into a run that writes. A uuid because the id goes straight into a
  // query, where a malformed one is 22P02.
  classify_priority: z.strictObject({ messageId: z.uuid() }),
  // The category classifier's twin of the line above, for the same reasons:
  // enqueued by `enqueueCategoryClassification`, re-run by hand after a
  // `failed` run whose dedupe key is spent.
  classify_category: z.strictObject({ messageId: z.uuid() }),
  // Enqueued in a routed ticket's insert transaction for the end of its
  // window, keyed on the ticket; re-run by hand after it dies, so strict, and a
  // uuid because the id goes straight into a locked read.
  settle_routing: z.strictObject({ conversationId: z.uuid() }),
  // `trigger` says who asked — an agent, a rule, or the sidebar's "Send now" —
  // because the admin may switch off surveys for rule-resolved tickets, and the
  // job cannot tell a rule's resolve from an agent's off the row.
  send_csat: z.object({
    conversationId: z.string().min(1),
    trigger: z.enum(SURVEY_TRIGGERS).optional(),
  }),
  // The survey, not the ticket: one alert per answer, and the handler's
  // once-only check keys on it. Strict because CI runs it by hand.
  notify_low_rating: z.strictObject({ surveyId: z.uuid() }),
  // Facebook and Instagram hand over a URL, WhatsApp an id to exchange for one.
  // The WhatsApp half names no source, so a Meta payload that lost its URL
  // matches neither half rather than being read as WhatsApp media.
  download_media: z.union([
    z.object({
      source: z.literal('meta'),
      messageId: z.string(),
      url: z.string().min(1),
      index: z.number().optional(),
    }),
    z.object({
      source: z.undefined().optional(),
      messageId: z.string(),
      mediaId: z.string(),
    }),
  ]),
  moderate_meta_comment: z.object({
    messageId: z.string(),
    action: z.enum(['hide', 'unhide', 'delete']),
    // Absent when the system moderates rather than an agent.
    agentId: z.string().nullish(),
  }),
  fetch_meta_profile: z.object({
    contactId: z.string(),
    platform: z.enum(['facebook', 'instagram']),
    userId: z.string(),
    /** Re-read a profile already on file. Used by the backfill, never by ingest. */
    force: z.boolean().optional(),
  }),
  sync_shipment: z
    .strictObject({
      shipmentId: z.string().optional(),
      /*
       * A number as well as a string, because `npm run job -- sync_shipment
       * trackingNumber=1755021358719` never reaches here as a string: `parsePayload`
       * coerces anything numeric-looking, and every real ShipBlu number is thirteen
       * digits of exactly that shape. It survives the round trip intact — thirteen
       * digits is well inside `Number.MAX_SAFE_INTEGER` — but it arrives typed as a
       * number, and a bare `typeof === 'string'` check would reject the one form an
       * operator is most likely to type.
       */
      trackingNumber: z.union([z.string(), z.number().transform(String)]).optional(),
      force: z.boolean().optional(),
    })
    .refine((payload) => payload.shipmentId || payload.trackingNumber, {
      message: 'requires a shipmentId or a trackingNumber',
    }),

  // The jobs an operator runs by hand, whose options arrive from `npm run job`'s
  // `key=value` parser: `true` and `false` as booleans, anything numeric as a
  // number, the rest as strings. An option that is present but wrong is
  // refused rather than read as absent, because absent is always the default
  // and a default is a real run: `limit=abc` would otherwise walk the archive.
  // A key they do not know is refused for the same reason: `limt=50` was
  // dropped, the default applied, and the run walked every contact.
  backfill_meta_profiles: z.strictObject({
    /** Re-read profiles already on file, rather than only the ones never asked. */
    force: z.boolean().optional(),
    /** Stop after this many contacts. Absent means all of them. */
    limit: z.number().int().positive().optional(),
  }),
  sync_stale_shipments: z.strictObject({
    /** Stop after this many parcels. Absent means the handler's `DEFAULT_LIMIT`. */
    limit: z.number().int().positive().optional(),
    /**
     * Also re-read parcels synced longer ago than this, in minutes.
     *
     * Absent by default, and that is a decision rather than a gap. How often a
     * moving parcel should be re-read is a question about the platform's rate
     * limits and about how fresh a status has to be, and nobody has answered
     * either — so the cadence is the operator's to set here or in a cron
     * schedule, not one for this file to invent. See PROJECT-STATE §6.
     */
    staleMinutes: z.number().positive().optional(),
  }),
  rollup_metrics: z.strictObject({
    /** A single day, as `YYYY-MM-DD`. */
    day: z.iso.date().optional(),
    /** Range start, inclusive. Defaults to the oldest day with any data. */
    from: z.iso.date().optional(),
    /** Range end, inclusive. Clamped to yesterday — today is never complete. */
    to: z.iso.date().optional(),
    /** The last N complete days, as an alternative to naming `from`. */
    days: z.number().positive().optional(),
  }),

  // The backfills and the knowledge-base passes: hand-run, or queued with no
  // options by an admin button. `dryRun` is the option these exist to get
  // right. Each handler tested `payload.dryRun === true`, so `dryRun=1` or
  // `dryRun=yes` — both meant as "do not write" — did a real run.
  //
  // And these refuse a key they do not know, as every job an operator types
  // does, where a schema only code writes drops it. A dropped key is harmless
  // on a payload code writes; on one an operator types, `dryrun=true` would be
  // dropped and the run would write.
  backfill_shipment_links: z.strictObject({
    /** Which messages are scanned, by when they were stored: see `scanBound`. */
    since: scanSince.optional(),
    until: scanUntil.optional(),
    /** Scan only, write nothing. Useful for checking a new pattern's yield. */
    dryRun: z.boolean().optional(),
    /** Stop after this many messages. Absent means the whole archive. */
    limit: z.number().int().positive().optional(),
  }),
  backfill_message_locations: z.strictObject({
    /** Which messages are scanned, by when they were stored: see `scanBound`. */
    since: scanSince.optional(),
    until: scanUntil.optional(),
    /** Scan and report, write nothing. */
    dryRun: z.boolean().optional(),
    /** Stop after this many candidate messages. Absent means the whole archive. */
    limit: z.number().int().positive().optional(),
  }),
  backfill_subcategorise_ai: z.strictObject({
    /**
     * Which experiment these rows belong to. Re-running one fills its gaps only.
     * A label of digits arrives from `npm run job` as a number, and was read as
     * no label at all — 'adhoc' — so it is turned back into the text it was.
     */
    runLabel: z.union([z.string(), z.number().transform(String)]).optional(),
    limit: z.number().int().positive().optional(),
    /** Which messages are considered, by when they were stored: see `scanBound`. */
    since: scanSince.optional(),
    until: scanUntil.optional(),
    /** Comma-separated channels, replacing the default "everything but the bot". */
    channels: z.string().optional(),
    /** Send the preceding inbound messages as context. On by default. */
    context: z.boolean().optional(),
    /** Only messages on tickets the rules filed as `meta.unclassified`. */
    onlyUnclassified: z.boolean().optional(),
    /** Select and build every request, call nothing, write nothing. */
    dryRun: z.boolean().optional(),
    /** Skip the run; print the report for `runLabel` as it stands. */
    reportOnly: z.boolean().optional(),
  }),
  backfill_category_ai: z
    .strictObject({
      /**
       * `record` asks Jev about the archive and writes only `ai_category_runs`;
       * `apply` files open tickets from a record label's answers. No default:
       * the two write different things, and the one an operator meant is not
       * a guess this file should make.
       */
      mode: z.enum(['record', 'apply']),
      /** The label `record` writes under. Re-running one fills its gaps only. */
      runLabel: backfillLabel.optional(),
      /** The record label `apply` files from. */
      fromLabel: backfillLabel.optional(),
      /** Which tickets, by when they were opened: see `scanBound`. */
      since: scanSince.optional(),
      until: scanUntil.optional(),
      /** Comma-separated channels, replacing the default "everything but the bot". */
      channels: z.string().optional(),
      /** Stop after this many tickets. */
      limit: z.number().int().positive().optional(),
      /** Select and build every request or write, call nothing, write nothing. */
      dryRun: z.boolean().optional(),
    })
    .superRefine((payload, context) => {
      const wrong = (message: string) => context.addIssue({ code: 'custom', message });
      if (payload.mode === 'record' && !payload.runLabel) wrong('mode=record needs runLabel=');
      if (payload.mode === 'record' && payload.fromLabel) wrong('fromLabel= is for mode=apply');
      if (payload.mode === 'apply' && !payload.fromLabel) {
        wrong('mode=apply needs fromLabel=, the record label to file from');
      }
      if (payload.mode === 'apply' && payload.runLabel) {
        wrong('runLabel= is for mode=record: apply writes no run rows');
      }
    }),
  normalise_kb_formatting: z.strictObject({
    /** Count and report what would change, write nothing. */
    dryRun: z.boolean().optional(),
    /** Stop after this many articles. Absent means all of them. */
    limit: z.number().int().positive().optional(),
    /** One locale only, for a cautious first run. */
    locale: z.enum(LOCALES).optional(),
  }),
  restore_resolved_at: z.strictObject({
    /** Report the tickets and the instants they would get, write nothing. */
    dryRun: z.boolean().optional(),
  }),
  seed_console_handbook: z.strictObject({
    /** Report what would change, write nothing. */
    dryRun: z.boolean().optional(),
    /** Also replace the title and body of articles that already exist. */
    overwrite: z.boolean().optional(),
  }),
  // No options: it only inserts what is missing, so there is nothing to
  // preview or overwrite. Strict all the same, so `dryRun=true` is refused
  // rather than taken for a run that writes.
  seed_ticket_categories: z.strictObject({}),
  seed_canned_responses: z.strictObject({
    /** Report what would change, write nothing. */
    dryRun: z.boolean().optional(),
    /**
     * Also replace the title, folder and bodies of seeded responses the team
     * has since edited. There is no version history for a canned response, so
     * this cannot be undone — run it with `dryRun=true` first, and aim it with
     * `keys`.
     */
    overwrite: z.boolean().optional(),
    /**
     * Comma-separated library keys (`finance.cod_limit,delivery.hours`): the
     * run touches only these. What makes one content fix shippable without
     * reverting every other response the team has edited.
     */
    keys: z.string().optional(),
  }),
  rotate_whatsapp_credentials: z.strictObject({
    /** Open every envelope it would move, and write nothing. */
    dryRun: z.boolean().optional(),
  }),
  // Strict, though code writes it: `npm run job` reaches it too, and a mistyped
  // `step=history` dropped by a lax schema would run every step instead of one.
  complete_coexistence_onboarding: z.strictObject({
    onboardingId: z.uuid(),
    /**
     * Run only these steps on a connected number — "copy the history" after
     * the connection, or the template sync. Only the steps that may be run
     * alone (`RERUNNABLE_STEPS` says why the others may not). Comma-separated
     * when typed (`steps=contacts,history`), since `npm run job` hands every
     * value over as a string.
     */
    steps: z
      .preprocess(
        (value) =>
          typeof value === 'string' ? value.split(',').map((step) => step.trim()) : value,
        z.array(z.enum(RERUNNABLE_STEPS)).nonempty(),
      )
      .optional(),
  }),
} satisfies Partial<Record<JobType, z.ZodType>>;

type CheckedJob = keyof typeof JOB_PAYLOADS;

/** What a caller must hand `enqueue` for a job of this type. */
export type JobPayload<T extends JobType> = T extends CheckedJob
  ? z.input<(typeof JOB_PAYLOADS)[T]>
  : Record<string, unknown>;

/**
 * The job's payload, checked against its type's schema.
 *
 * Throws `PermanentJobError`, so a malformed payload goes to `dead` on its first
 * attempt with the reason in `last_error` rather than spending its retries.
 */
export function parseJobPayload<T extends CheckedJob>(
  job: ClaimedJob,
  type: T,
): z.output<(typeof JOB_PAYLOADS)[T]> {
  const parsed = JOB_PAYLOADS[type].safeParse(job.payload);
  if (!parsed.success) {
    throw new PermanentJobError(`${type}: invalid payload — ${parsed.error.message}`);
  }
  return parsed.data as z.output<(typeof JOB_PAYLOADS)[T]>;
}
