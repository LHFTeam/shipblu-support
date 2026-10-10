import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  channels,
  type OnboardingStep,
  type OnboardingStepRecord,
  whatsappOnboardings,
} from '@/db/schema';
import { env, metaAppSecret } from '@/lib/env';
import { errorMessage } from '@/lib/errors';
import { logger } from '@/lib/log';
import {
  COEXISTENCE_WHATSAPP_FIELDS,
  readSubscription,
  WHATSAPP_OBJECT,
} from '@/lib/meta/subscriptions';
import { type ClaimedJob, enqueue, isFinalAttempt, retryDelaySeconds } from '@/lib/queue';
import { credentialsForAccount, listAccounts } from './accounts';
import { callGraph, type GraphRequest, WhatsAppApiError } from './client';
import {
  canRequestSync,
  type Coexistence,
  copiedSoFar,
  parseCoexistence,
  type SyncType,
} from './coexistence';
import { recordSyncRequest, writeOnboardedCoexistence } from './coexistence-state';
import { CredentialKeyError } from './credential-envelope';
import { ACCESS_TOKEN_CODE, explainAuthError } from './errors';
import { redact } from './onboarding';
import { runsNamedSteps } from './onboarding-reads';
import {
  numberPlatformRequest,
  phoneNumbersRequest,
  smbAppDataRequest,
  subscribeAppRequest,
  subscribedAppsRequest,
} from './onboarding-requests';
import { NUMBER_NOT_ON_ACCOUNT } from './onboarding-view';

const log = logger('complete_coexistence_onboarding');

/**
 * Connecting a WhatsApp Business-app number — the half that runs in the worker.
 *
 * `./onboarding` has already exchanged Meta's code, stored the business token
 * and inserted the attempt as `exchanged`. This takes it from there, with the
 * stored credential, in six steps, each recorded on the row as it lands:
 *
 *   number     the number is on the WABA the browser named, read with the token
 *   subscribe  this app is subscribed to the WABA's webhooks — read back, since
 *              a 200 on the subscribe is not proof — and the app-level fields
 *              a Business-app number needs are checked, and named if missing
 *   channel    the channel is created, or found and rewritten on a reconnect
 *   contacts,  the phone is asked for its contacts and its chat history, once,
 *   history    inside the 24 hours Meta allows; a refusal is recorded and the
 *              run goes on, because a connected number is worth having without
 *   templates  the template sync is queued, so the picker fills in a minute
 *
 * A step that already succeeded is skipped on a re-run, and `only` runs named
 * copy steps alone on a connected number — "copy the history" from the channel
 * row is this with `['history']`. Phone registration is deliberately absent:
 * Meta's guide for this flow says to "skip the phone number registration step,
 * as the number is already registered".
 *
 * **Once the channel exists, the number is connected**, and nothing after it —
 * a copy Meta refused, a template sync that would not queue — turns that back
 * into a failure: the step says what went wrong and the attempt finishes
 * `connected`, where the "copy again" button can reach it.
 *
 * Worker-only, because it resolves the stored credential. `credential-
 * confinement` holds that: this module may import a resolver, and only modules
 * under `worker/` may import this one.
 */

/**
 * A failure no retry can fix: the attempt is marked failed with this sentence.
 * `outcome` is recorded on the failed step where the page needs to tell one
 * failure from another without reading the sentence (`NUMBER_NOT_ON_ACCOUNT`).
 */
class StepFailed extends Error {
  constructor(
    message: string,
    readonly outcome?: string,
  ) {
    super(message);
  }
}

/** A failure a retry may fix, that Meta did not word as an error. */
class StepNotYet extends Error {}

type Onboarding = typeof whatsappOnboardings.$inferSelect;
type Progress = { step: OnboardingStep | 'credential'; connected: boolean };

export type CompleteOutcome = 'connected' | 'failed' | 'skipped' | 'gone';

/**
 * Runs the job half for one attempt.
 *
 * Answers rather than throws for the outcomes the row already records; throws
 * only what the queue should retry, after writing on the row when it will — so
 * the page reads "Meta answered 503 on subscribe, retrying in 40s" instead of a
 * spinner. On the job's last attempt it leaves the row final instead: failed if
 * the number never connected, connected with the step's error if it did.
 */
export async function completeOnboarding(
  onboardingId: string,
  options: {
    only?: OnboardingStep[];
    job: Pick<ClaimedJob, 'attempts' | 'maxAttempts'>;
  },
): Promise<CompleteOutcome> {
  const [row] = await db
    .select()
    .from(whatsappOnboardings)
    .where(eq(whatsappOnboardings.id, onboardingId))
    .limit(1);

  if (!row) return 'gone';

  const targeted = options.only !== undefined;

  // A full run is for an attempt still connecting; a targeted one is for a
  // number already connected — `runsNamedSteps`, which the copy button's
  // action asks too, so it refuses with a sentence what this would skip.
  // Anything else is a job that outlived its purpose — a retry that raced a
  // supersede, a double-click — and does nothing, rather than reopening a
  // decision somebody else already made.
  if ((!targeted && row.status !== 'exchanged') || (targeted && !runsNamedSteps(row.status))) {
    log.info(`${onboardingId} is ${row.status}; nothing to do`, {
      onboardingId,
      status: row.status,
    });
    return 'skipped';
  }

  await db
    .update(whatsappOnboardings)
    .set({ attempts: options.job.attempts, updatedAt: new Date() })
    .where(eq(whatsappOnboardings.id, row.id));

  const progress: Progress = { step: 'credential', connected: row.steps.channel?.ok === true };

  try {
    await runSteps(row, options.only, progress);
    await finish(row.id, targeted);
    log.info(`${onboardingId} ${targeted ? `ran ${options.only!.join(', ')}` : 'connected'}`, {
      onboardingId,
      phoneNumberId: row.phoneNumberId,
    });
    return 'connected';
  } catch (error) {
    if (error instanceof StepFailed || error instanceof CredentialKeyError) {
      const sentence =
        error instanceof CredentialKeyError
          ? `The stored credential could not be opened: ${error.message}`
          : error.message;
      // Where it failed — or, for a targeted run that failed before reaching
      // any step, on each step it was asked for, so the button that asked
      // shows why nothing happened.
      const failedSteps =
        progress.step !== 'credential' ? [progress.step] : targeted ? options.only! : [];
      const outcome = error instanceof StepFailed ? error.outcome : undefined;
      for (const step of failedSteps)
        await recordStep(row.id, step, {
          ok: false,
          error: sentence,
          ...(outcome ? { outcome } : {}),
        });

      // A connected number stays connected: the step failed, the connection did not.
      if (targeted || progress.connected) await finish(row.id, targeted);
      else await markFailed(row.id, sentence);
      log.warn(`${onboardingId} failed on ${progress.step}: ${sentence}`);
      return progress.connected || targeted ? 'connected' : 'failed';
    }

    const sentence = `${describe(error)} on ${progress.step}`;

    if (isFinalAttempt(options.job)) {
      const gaveUp = `${sentence} — gave up after ${options.job.attempts} attempt${
        options.job.attempts === 1 ? '' : 's'
      }`;
      if (targeted || progress.connected) {
        // The number works; the step that would not finish says so, and the
        // row stops promising a retry the queue is not going to make.
        if (progress.step !== 'credential') {
          await recordStep(row.id, progress.step, { ok: false, error: gaveUp });
        }
        if (!targeted && !row.steps.templates?.ok) await queueTemplateSync(row.id);
        await finish(row.id, targeted);
        log.warn(`${onboardingId} connected; ${gaveUp}`);
        return 'connected';
      }
      await markFailed(row.id, gaveUp);
    } else {
      await db
        .update(whatsappOnboardings)
        .set({
          lastTransientError: sentence.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + retryDelaySeconds(options.job.attempts) * 1000),
          updatedAt: new Date(),
        })
        .where(eq(whatsappOnboardings.id, row.id));
    }
    throw error;
  }
}

/** The attempt is done: connected for a full run, left as it was for a targeted one. */
async function finish(onboardingId: string, targeted: boolean): Promise<void> {
  await db
    .update(whatsappOnboardings)
    .set({
      ...(targeted ? {} : { status: 'connected' as const, finishedAt: new Date() }),
      lastTransientError: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(whatsappOnboardings.id, onboardingId));
}

/**
 * `callGraph`, with the stored token and the app secret cut out of anything
 * Meta says back.
 *
 * Every sentence this job records starts here — a step's error or warning,
 * `last_transient_error`, the attempt's `error`, the worker log — and each is
 * read by somebody: the first three on the channels page, the last wherever
 * Render's logs go. Graph is not known to echo a bearer token, but nothing in
 * its contract promises it never will, and the first phase already cuts the
 * same secrets out of the same kind of sentence (`./onboarding`). Done once,
 * to the error as it leaves Graph, rather than at each of the dozen places
 * that repeat it, so the next sentence somebody adds cannot be the one that
 * forgot.
 */
async function askGraph<T>(request: GraphRequest, token: string): Promise<T | null> {
  try {
    return await callGraph<T>(request, token);
  } catch (error) {
    throw scrubbed(error, secretsOf(token));
  }
}

/**
 * What this job holds that no sentence may repeat: the business token, and the
 * app secret inside the app token the subscription read goes out with.
 */
function secretsOf(token: string): string[] {
  return [token, metaAppSecret() ?? ''];
}

/**
 * `error` with `secrets` cut out of what it says, and still the same kind of
 * error: the steps read a `WhatsAppApiError`'s code and `isTransient` to choose
 * between a retry, a recorded refusal and a failed attempt, so the scrubbed one
 * has to answer those exactly as Meta's did.
 */
function scrubbed(error: unknown, secrets: readonly string[]): unknown {
  if (error instanceof WhatsAppApiError) {
    const message = redact(error.message, secrets);
    const details = error.details === null ? null : redact(error.details, secrets);
    if (message === error.message && details === error.details) return error;
    return new WhatsAppApiError(message, error.status, error.code, details, error.isTransient);
  }
  // A network failure names a host and a path, never the header the token
  // rides in; this is for the failure that is not so polite.
  const message = errorMessage(error);
  const clean = redact(message, secrets);
  return clean === message ? error : new Error(clean);
}

function describe(error: unknown): string {
  if (error instanceof WhatsAppApiError) {
    return `Meta answered ${error.status || 'nothing'}${error.code ? ` (${error.code})` : ''}: ${error.message}`;
  }
  return errorMessage(error);
}

async function markFailed(onboardingId: string, sentence: string): Promise<void> {
  await db
    .update(whatsappOnboardings)
    .set({
      status: 'failed',
      error: sentence.slice(0, 2000),
      finishedAt: new Date(),
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(whatsappOnboardings.id, onboardingId));
}

/**
 * One step's outcome, merged into `steps` in one statement — so the page,
 * polling, sees each step as it lands. Takes the transaction a step's own
 * write runs in, where there is one, so the write and its record cannot part.
 */
async function recordStep(
  onboardingId: string,
  step: OnboardingStep,
  record: Omit<OnboardingStepRecord, 'at'>,
  executor: typeof db = db,
): Promise<void> {
  const value: OnboardingStepRecord = { at: new Date().toISOString(), ...record };
  await executor
    .update(whatsappOnboardings)
    .set({
      steps: sql`jsonb_set(${whatsappOnboardings.steps}, ${`{${step}}`}::text[], ${JSON.stringify(value)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(whatsappOnboardings.id, onboardingId));
}

/** What the number step learned: the channel's name, and whether there is a phone to copy. */
type NumberFacts = {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  /** False only when Meta says so; unknown counts as on the app. */
  onBusinessApp: boolean;
};

/** The channel this attempt connected, and what an earlier connection already copied. */
type ConnectedChannel = { id: string; previouslyCopied: SyncType[] };

async function runSteps(
  row: Onboarding,
  only: OnboardingStep[] | undefined,
  progress: Progress,
): Promise<void> {
  const account = (await listAccounts()).find(
    (candidate) => candidate.id === row.whatsappAccountId,
  );
  if (!account) {
    throw new StepFailed(
      `Business account ${row.wabaId} was disconnected while this number was being connected.`,
    );
  }

  // Asked before resolving, because resolving would fall through to another
  // credential: connecting the number with the shared token instead would be a
  // different connection than the one the admin signed for, and a missing
  // shared token would fail with a sentence about the wrong thing.
  if (!account.hasStoredToken) {
    throw new StepFailed(
      'The credential stored when this number was signed in through Meta has since been ' +
        'forgotten. Connect the number again.',
    );
  }
  const credentials = await credentialsForAccount(account);
  if (credentials.source !== 'stored') {
    throw new StepFailed(
      'The credential stored when this number was signed in through Meta has since been ' +
        'forgotten. Connect the number again.',
    );
  }
  const token = credentials.token;

  const wants = (step: OnboardingStep) => (only ? only.includes(step) : true);
  const done = (step: OnboardingStep) => !only && row.steps[step]?.ok === true;

  // A read, so run on every full run: the channel and copy steps need it.
  let facts: NumberFacts = { displayPhoneNumber: null, verifiedName: null, onBusinessApp: true };
  if (!only) {
    progress.step = 'number';
    facts = await numberStep(row, token);
  }

  let subscribedAt = row.steps.subscribe?.ok ? row.steps.subscribe.at : null;
  if (wants('subscribe') && !done('subscribe')) {
    progress.step = 'subscribe';
    subscribedAt = await subscribeStep(row, token);
  }

  let channel: ConnectedChannel | null = row.channelId
    ? { id: row.channelId, previouslyCopied: row.steps.channel?.previouslyCopied ?? [] }
    : null;
  if (wants('channel') && !done('channel')) {
    progress.step = 'channel';
    channel = await channelStep(row, facts, subscribedAt);
  }
  if (channel) progress.connected = true;

  for (const type of ['contacts', 'history'] as const) {
    if (!wants(type) || done(type)) continue;
    progress.step = type;
    if (!channel) {
      await recordStep(row.id, type, {
        ok: false,
        error: 'The number has no channel yet, so there is nowhere to copy it into.',
      });
      continue;
    }
    if (!facts.onBusinessApp) {
      await recordStep(row.id, type, {
        ok: true,
        outcome: 'not_applicable',
        detail: 'Not requested: Meta says this number is not on the WhatsApp Business app.',
      });
      continue;
    }
    // A reconnect does not copy again what the earlier connection already
    // copied — asking re-sends every chunk of it. What it did not copy (never
    // asked, refused, declined on the phone) is asked for now: the reconnect
    // is the new window the earlier refusal told the admin to open.
    if (channel.previouslyCopied.includes(type) && !only) {
      await recordStep(row.id, type, {
        ok: true,
        outcome: 'previously_copied',
        detail:
          'Not requested: copied when this number was connected before. It can be copied ' +
          'again from the channel in the next 24 hours.',
      });
      continue;
    }
    await syncStep(row, channel.id, type, token);
  }

  if (wants('templates') && !done('templates')) {
    progress.step = 'templates';
    await queueTemplateSync(row.id);
  }
}

/**
 * Queues the template sync so the agent's picker fills in a minute rather than
 * at the top of the hour. Always queued: the sync is idempotent, and the hourly
 * one is a cron run outside the queue that no check here could see.
 */
async function queueTemplateSync(onboardingId: string): Promise<void> {
  await enqueue('sync_whatsapp_templates', {});
  await recordStep(onboardingId, 'templates', { ok: true, detail: 'Template sync queued.' });
}

/** A refusal of the token itself is not a step to retry: it needs a person. */
function refusedToken(error: unknown): void {
  if (error instanceof WhatsAppApiError && error.code === ACCESS_TOKEN_CODE) {
    throw new StepFailed(explainAuthError(error.code, error.message, { source: 'stored' }));
  }
}

/** A Meta refusal no retry changes, as the attempt's failure. */
function permanently(error: unknown, what: string): never {
  refusedToken(error);
  if (error instanceof WhatsAppApiError && !error.isTransient) {
    throw new StepFailed(`${what}: ${error.message}`);
  }
  throw error;
}

async function numberStep(row: Onboarding, token: string): Promise<NumberFacts> {
  let listed: {
    data?: { id?: string; display_phone_number?: string; verified_name?: string }[];
  } | null;
  try {
    listed = await askGraph(phoneNumbersRequest(row.wabaId), token);
  } catch (error) {
    permanently(error, `Meta would not list the numbers on business account ${row.wabaId}`);
  }

  const numbers = listed?.data ?? [];
  const number = numbers.find((candidate) => candidate.id === row.phoneNumberId);
  if (!number) {
    throw new StepFailed(
      `Number ${row.phoneNumberId} is not on business account ${row.wabaId} — Meta lists ` +
        `${numbers.map((candidate) => candidate.id).join(', ') || 'no numbers'} there. ` +
        `Connect again and choose the number the WhatsApp Business app uses.`,
      NUMBER_NOT_ON_ACCOUNT,
    );
  }

  const facts: NumberFacts = {
    displayPhoneNumber: number.display_phone_number ?? null,
    verifiedName: number.verified_name ?? null,
    onBusinessApp: true,
  };

  // Optional, and so never the reason a connection fails: the coexistence
  // guide's own check, `is_on_biz_app` true and `platform_type` CLOUD_API.
  const warnings: string[] = [];
  try {
    const platform = await askGraph<{ is_on_biz_app?: boolean; platform_type?: string }>(
      numberPlatformRequest(row.phoneNumberId),
      token,
    );
    if (platform?.is_on_biz_app === false) {
      facts.onBusinessApp = false;
      warnings.push(
        'Meta says this number is not on the WhatsApp Business app, so it is connected as a ' +
          'Cloud API number with no phone to copy history from.',
      );
    }
    if (platform?.platform_type && platform.platform_type !== 'CLOUD_API') {
      warnings.push(
        `Meta reports the number's platform as ${platform.platform_type}, not CLOUD_API, so ` +
          `sending from it may not work yet.`,
      );
    }
  } catch (error) {
    refusedToken(error);
    warnings.push(
      `Could not confirm the number is on the WhatsApp Business app: ${describe(error)}.`,
    );
  }

  await recordStep(row.id, 'number', {
    ok: true,
    detail: [facts.displayPhoneNumber, facts.verifiedName].filter(Boolean).join(' · '),
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  });
  return facts;
}

async function subscribeStep(row: Onboarding, token: string): Promise<string> {
  const appId = env().META_APP_ID;
  if (!appId) {
    throw new StepFailed('META_APP_ID is not set, so the subscription cannot be checked.');
  }

  let apps: { data?: { whatsapp_business_api_data?: { id?: string } }[] } | null;
  try {
    // A lost answer (null) is fine here: the read-back below is the proof.
    await askGraph(subscribeAppRequest(row.wabaId), token);
    apps = await askGraph(subscribedAppsRequest(row.wabaId), token);
  } catch (error) {
    permanently(error, `Meta refused to subscribe this app to business account ${row.wabaId}`);
  }

  if (!apps?.data?.some((entry) => entry.whatsapp_business_api_data?.id === appId)) {
    // Retried rather than failed: a subscription that has not shown up yet
    // looks exactly like this, and running the step again is what fixes it.
    throw new StepNotYet(
      `Meta accepted the subscription, but app ${appId} is not yet listed on business ` +
        `account ${row.wabaId}`,
    );
  }

  // The app-level fields are a different subscription — the app's, made with
  // the app token — and the one thing this job cannot change for itself. Named
  // rather than hidden: without them the number connects and every phone-typed
  // reply and every chunk of history falls on the floor.
  let warning: string | undefined;
  try {
    const subscription = await readSubscription(WHATSAPP_OBJECT);
    const have = new Set((subscription?.fields ?? []).map((field) => field.name));
    const missing = COEXISTENCE_WHATSAPP_FIELDS.filter((field) => !have.has(field));
    if (missing.length > 0) {
      warning =
        `This app is not subscribed to ${missing.join(', ')} for WhatsApp, so the copied history ` +
        `and contacts, and replies typed on the phone, will not arrive until it is. ` +
        `\`npm run job -- subscribe_meta_webhooks\` adds them.`;
    }
  } catch (error) {
    // Read with the app token, `{app id}|{app secret}`, which `askGraph` does
    // not see — so cut here, by hand, for the same reason it cuts.
    warning = `Could not read this app's webhook fields to check them: ${redact(
      errorMessage(error),
      secretsOf(token),
    )}.`;
  }

  const at = new Date().toISOString();
  await recordStep(row.id, 'subscribe', {
    ok: true,
    detail: `App ${appId} is subscribed to business account ${row.wabaId}.`,
    ...(warning ? { warning } : {}),
  });
  return at;
}

/**
 * Creates the channel, or finds it — and tells three cases apart by what its
 * `coexistence` object says, not by whether there is one:
 *
 * - **this attempt's own**, written by an earlier run of it whose step record
 *   was lost: left exactly as it is, since rewriting it would reset the copy
 *   window and forget the requests already made;
 * - **an earlier connection's** — a reconnect: rewritten for this one, and
 *   what that connection finished copying is passed on so it is not asked
 *   for twice;
 * - **none**, a plain Cloud API channel for this number: taken over.
 *
 * The channel write and its step record share one transaction, so a run that
 * dies between them cannot leave a channel whose step says it was never made.
 */
async function channelStep(
  row: Onboarding,
  facts: NumberFacts,
  subscribedAt: string | null,
): Promise<ConnectedChannel> {
  const existing = await db
    .select({ id: channels.id, type: channels.type, name: channels.name, config: channels.config })
    .from(channels)
    .where(
      and(
        inArray(channels.type, ['whatsapp', 'whatsapp_bot']),
        sql`${channels.config} ->> 'phoneNumberId' = ${row.phoneNumberId}`,
      ),
    );

  if (existing.some((channel) => channel.type === 'whatsapp_bot')) {
    throw new StepFailed(
      `Number ${row.phoneNumberId} is the customer bot's channel, which another service ` +
        `answers. Connecting it as a support number would put the team's replies in the bot's ` +
        `conversations; change the bot channel first.`,
    );
  }

  const coexistence: Coexistence = {
    onboardingId: row.id,
    // The exchange, which is when Meta's 24 hours began — not now, which on a
    // retry days later would open a window Meta closed long ago.
    onboardedAt: row.createdAt.toISOString(),
    wabaId: row.wabaId,
    displayPhoneNumber: facts.displayPhoneNumber,
    verifiedName: facts.verifiedName,
    subscribedAt,
    syncs: {},
    // On the channel, not only on the step records: the row's badges and copy
    // buttons read this object, and without it a number with no phone to copy
    // from is offered a copy, and a day later a reconnect for one it missed.
    ...(facts.onBusinessApp ? {} : { notOnBusinessApp: true as const }),
  };

  const current = existing[0];
  if (current) {
    const previous = parseCoexistence(current.config);

    if (previous?.onboardingId === row.id) {
      // What this attempt carried over when it wrote the object, so a re-run
      // skips those copies exactly as the run that wrote it would have — and
      // records them, so a run after this one finds them on the step too.
      const previouslyCopied = previous.carriedOver ?? [];
      await db.transaction(async (tx) => {
        await tx
          .update(whatsappOnboardings)
          .set({ channelId: current.id, updatedAt: new Date() })
          .where(eq(whatsappOnboardings.id, row.id));
        await recordStep(
          row.id,
          'channel',
          {
            ok: true,
            outcome: 'connected',
            previouslyCopied,
            detail: `Connected channel "${current.name}".`,
          },
          tx,
        );
      });
      return { id: current.id, previouslyCopied };
    }

    // What an earlier connection finished copying — any earlier one, not only
    // the last: a reconnect asks for nothing it carried over, so its own slots
    // are empty, and reading only those would have the reconnect after it ask
    // the phone for six months of chats again. Finished, not merely asked for:
    // a copy that stalled is what its badge sends the admin here to fix, and
    // one declined on the phone may be shared this time (`copiedSoFar`).
    const previouslyCopied = previous ? copiedSoFar(previous) : [];

    await db.transaction(async (tx) => {
      // Pointed at this account and switched on: the number now sends with
      // the credential this attempt stored. Its name and group are the team's
      // and are kept.
      await tx
        .update(channels)
        .set({ whatsappAccountId: row.whatsappAccountId, isActive: true, updatedAt: new Date() })
        .where(eq(channels.id, current.id));
      await writeOnboardedCoexistence(tx, current.id, {
        ...coexistence,
        ...(previouslyCopied.length > 0 ? { carriedOver: previouslyCopied } : {}),
      });
      await tx
        .update(whatsappOnboardings)
        .set({ channelId: current.id, updatedAt: new Date() })
        .where(eq(whatsappOnboardings.id, row.id));
      await recordStep(
        row.id,
        'channel',
        {
          ok: true,
          outcome: previous ? 'reconnected' : 'connected',
          previouslyCopied,
          detail: `${previous ? 'Reconnected' : 'Connected'} channel "${current.name}".`,
        },
        tx,
      );
    });
    return { id: current.id, previouslyCopied };
  }

  const name = await freeChannelName(
    facts.verifiedName ?? facts.displayPhoneNumber ?? `WhatsApp ${row.phoneNumberId}`,
  );

  const created = await db.transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        type: 'whatsapp',
        name,
        defaultGroupId: row.defaultGroupId,
        whatsappAccountId: row.whatsappAccountId,
        config: { phoneNumberId: row.phoneNumberId, coexistence },
      })
      // `channels_name_idx`: a channel given this name since it was chosen.
      // Retried, which picks another.
      .onConflictDoNothing()
      .returning({ id: channels.id });
    if (!channel) return null;
    await tx
      .update(whatsappOnboardings)
      .set({ channelId: channel.id, updatedAt: new Date() })
      .where(eq(whatsappOnboardings.id, row.id));
    await recordStep(
      row.id,
      'channel',
      { ok: true, outcome: 'created', detail: `Created channel "${name}".` },
      tx,
    );
    return channel;
  });

  if (!created) {
    throw new StepNotYet(`A channel named "${name}" appeared while this one was being created`);
  }
  return { id: created.id, previouslyCopied: [] };
}

/**
 * Meta's two refusals of a copy request, which both mean "reconnect", in words
 * an admin can act on: 2593107, already asked as many times as allowed, and
 * 2593108, asked more than 24 hours after the number was connected (Meta's
 * synchronization errors). Anything else is Meta's own sentence.
 */
function explainSyncRefusal(error: WhatsAppApiError): string {
  if (error.code === ALREADY_REQUESTED) {
    return `${error.message} — Meta allows each copy once per connection; disconnecting the number from the WhatsApp Business app and connecting it again opens another.`;
  }
  if (error.code === WINDOW_PASSED) {
    return `${error.message} — the 24 hours after connecting have passed; disconnecting the number from the WhatsApp Business app and connecting it again opens a new window.`;
  }
  return error.message;
}

const ALREADY_REQUESTED = 2593107;
const WINDOW_PASSED = 2593108;

/**
 * A channel name nobody holds: the verified name, then numbered after it.
 * Every name is read and compared here rather than matched with LIKE — the
 * table holds a handful of rows, and a pattern built from a business's name
 * would have to escape it (`lib/search/like.ts` says why that goes wrong).
 */
async function freeChannelName(preferred: string): Promise<string> {
  const base = preferred.trim().slice(0, 80) || 'WhatsApp';
  const taken = new Set(
    (await db.select({ name: channels.name }).from(channels)).map((channel) => channel.name),
  );
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

async function syncStep(
  row: Onboarding,
  channelId: string,
  type: SyncType,
  token: string,
): Promise<void> {
  const [channel] = await db
    .select({ config: channels.config })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  const coexistence = channel ? parseCoexistence(channel.config) : null;
  if (!coexistence) {
    await recordStep(row.id, type, {
      ok: false,
      error: 'The channel no longer carries its connection details, so nothing was requested.',
    });
    return;
  }

  const permission = canRequestSync(coexistence, type, new Date());
  if (!permission.ok) {
    // This attempt's own request, recorded on the channel by a run that died
    // before recording it here. The connection's copies are this attempt's
    // alone — a reconnect starts them empty — so it is not a refusal.
    const slot = coexistence.syncs[type];
    if (
      permission.reason === 'already_requested' &&
      coexistence.onboardingId === row.id &&
      slot &&
      'requestId' in slot
    ) {
      await recordStep(row.id, type, {
        ok: true,
        detail: `Requested earlier in this connection (Meta's request ${slot.requestId}).`,
      });
      return;
    }
    await recordStep(row.id, type, { ok: false, error: permission.sentence });
    return;
  }

  // Marked before the request goes out. If its answer is lost, the queue runs
  // this again and Meta answers "already requested" — and this marker, left by
  // the earlier attempt, is how that answer is read as the first request having
  // gone through rather than as a refusal.
  const askedBefore = row.steps[type]?.outcome === 'sending';
  await recordStep(row.id, type, {
    ok: false,
    outcome: 'sending',
    detail: 'Asking the phone for it.',
  });

  const at = new Date();
  let answer: { request_id?: string } | null;
  try {
    answer = await askGraph(smbAppDataRequest(row.phoneNumberId, type), token);
  } catch (error) {
    refusedToken(error);
    if (error instanceof WhatsAppApiError && askedBefore && error.code === ALREADY_REQUESTED) {
      await recordSyncRequest(channelId, type, { requestId: 'unconfirmed' }, at);
      await recordStep(row.id, type, {
        ok: true,
        detail:
          'Requested: an earlier attempt asked and its answer was lost, and Meta says it was ' +
          'already asked — so the copy is on its way, without a request id.',
      });
      return;
    }
    if (error instanceof WhatsAppApiError && !error.isTransient) {
      // Recorded and survived: Meta refused the request itself — asked twice,
      // too late, or not allowed — and the number is connected regardless. A
      // business declining to share its history on the phone does not land
      // here: Meta accepts the request and says so later, in a history webhook
      // carrying 2593109.
      const sentence = explainSyncRefusal(error);
      await recordSyncRequest(channelId, type, { error: sentence }, at);
      await recordStep(row.id, type, { ok: false, error: sentence });
      return;
    }
    throw error;
  }

  // A lost answer to a POST Meta accepted: the copy will still arrive, and
  // asking again would be refused as already asked. Recorded as asked.
  const requestId = typeof answer?.request_id === 'string' ? answer.request_id : 'unconfirmed';
  await recordSyncRequest(channelId, type, { requestId }, at);
  await recordStep(row.id, type, {
    ok: true,
    detail:
      requestId === 'unconfirmed'
        ? 'Requested; Meta accepted it but its answer was lost, so there is no request id.'
        : `Requested (Meta's request ${requestId}). Keep the WhatsApp Business app open on the phone until it finishes.`,
  });
}
