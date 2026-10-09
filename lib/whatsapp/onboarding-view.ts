import type { OnboardingStatus, OnboardingStep, OnboardingStepRecord } from '@/db/schema';
import { type Coexistence, isSyncing } from './coexistence';

/**
 * What the admin page shows of an attempt to connect a WhatsApp Business-app
 * number — the plain shape the page hands its client component, and the
 * sentences that component prints.
 *
 * Pure and client-safe, split from `./onboarding-reads` the way
 * `lib/kb/floors.ts` is split from `lib/kb/internal.ts`: the progress card is
 * a `'use client'` component, and the module that reads the row imports the
 * database. The types above come in as types only, which the bundle never
 * sees; the step *order* does not live here at all — `ONBOARDING_STEPS` in the
 * schema owns it, and the reader passes it in, so this module cannot drift
 * from the job that records the steps.
 *
 * Every instant is an ISO string rather than a `Date`: the view crosses from a
 * server component to a client one, and a string compares, serialises and
 * tests the same on both sides.
 */

/** A row of `whatsapp_onboardings`, as this module needs it. */
export type OnboardingRow = {
  id: string;
  status: OnboardingStatus;
  steps: Partial<Record<OnboardingStep, OnboardingStepRecord>>;
  attempts: number;
  nextAttemptAt: Date | null;
  lastTransientError: string | null;
  error: string | null;
  channelId: string | null;
  phoneNumberId: string;
  wabaId: string;
  startedAt: Date;
  finishedAt: Date | null;
  startedByLabel: string | null;
};

export type OnboardingStepState = 'pending' | 'running' | 'done' | 'failed';

export type OnboardingStepView = {
  step: OnboardingStep;
  label: string;
  state: OnboardingStepState;
  /** When the step was last recorded, so a retry can tell its own movement from the last run's. */
  at: string | null;
  /** What the step says about itself: its detail, or why it failed. */
  sentence: string | null;
  /**
   * Something the step noticed beside its result: the app-level webhook fields
   * a person still has to add, or what Meta says about the number.
   * `connectedFollowUps` says which of the two a warning is.
   */
  warning: string | null;
  /** The step's result in a word, where it recorded one (`OnboardingStepRecord.outcome`). */
  outcome: string | null;
};

export type OnboardingView = {
  id: string;
  status: OnboardingStatus;
  steps: OnboardingStepView[];
  attempts: number;
  nextAttemptAt: string | null;
  lastTransientError: string | null;
  error: string | null;
  channelId: string | null;
  phoneNumberId: string;
  wabaId: string;
  startedAt: string;
  finishedAt: string | null;
  startedByLabel: string | null;
};

/** What each step is doing, in the words the card prints beside it. */
export const STEP_LABELS: Record<OnboardingStep, string> = {
  number: 'Checking the number is on the business account',
  subscribe: 'Subscribing to its events',
  channel: 'Creating the channel',
  contacts: 'Asking the phone for its contacts',
  history: 'Asking the phone for up to six months of chats',
  templates: "Fetching the account's message templates",
};

/**
 * One step's state on the card.
 *
 * `running` is the step the job is on: a record marked `sending` (its request
 * is out), or the current step of an attempt still `exchanged`. Once the
 * attempt is final, a step with no record is simply pending: nothing is
 * running it.
 */
export function stepState(
  record: OnboardingStepRecord | undefined,
  current: boolean,
): OnboardingStepState {
  if (record?.ok) return 'done';
  if (record?.outcome === 'sending' || current) return 'running';
  if (record) return 'failed';
  return 'pending';
}

/**
 * The step a running attempt is on, read off the records the job writes in
 * order: the one after the last recorded step, or that step itself when it
 * failed — a retry runs a failed step again, and the card should say so
 * rather than pointing at the step after it. Nothing once the attempt is final.
 */
function currentStep(row: OnboardingRow, order: readonly OnboardingStep[]): OnboardingStep | null {
  if (row.status !== 'exchanged') return null;
  const lastIndex = order.findLastIndex((step) => row.steps[step]);
  if (lastIndex === -1) return order[0] ?? null;
  const last = row.steps[order[lastIndex]!];
  return last?.ok ? (order[lastIndex + 1] ?? null) : order[lastIndex]!;
}

export function toOnboardingView(
  row: OnboardingRow,
  order: readonly OnboardingStep[],
): OnboardingView {
  const current = currentStep(row, order);

  return {
    id: row.id,
    status: row.status,
    steps: order.map((step) => {
      const record = row.steps[step];
      return {
        step,
        label: STEP_LABELS[step],
        state: stepState(record, step === current),
        at: record?.at ?? null,
        sentence: record?.error ?? record?.detail ?? null,
        warning: record?.warning ?? null,
        outcome: record?.outcome ?? null,
      };
    }),
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    lastTransientError: row.lastTransientError,
    error: row.error,
    channelId: row.channelId,
    phoneNumberId: row.phoneNumberId,
    wabaId: row.wabaId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    startedByLabel: row.startedByLabel,
  };
}

/**
 * How long an `exchanged` attempt may show no movement before the card says a
 * worker has not picked it up. The queue claims a job within seconds when a
 * worker is up, so a minute of nothing is a worker that is down or busy.
 */
export const STALL_AFTER_MS = 60_000;

/**
 * How long an `exchanged` attempt counts as live before another may replace it,
 * or a retry may start it again. Here rather than in `./onboarding`, which
 * decides on it in SQL, so the card can offer Retry at the moment the server
 * would accept it instead of guessing at a moment of its own.
 */
export const LIVE_ATTEMPT_MS = 15 * 60 * 1000;

/** How often the card asks while something is moving, and while it is only waiting. */
const FAST_POLL_MS = 3_000;
const SLOW_POLL_MS = 15_000;

/**
 * How long after its start an attempt Retry applies to is still asked about.
 * Past it the card stops: it already shows Retry, which moves `startedAt` and
 * so starts the asking again, and a reload reads whatever a late worker did.
 * Without the bound, an attempt whose job is gone was asked about every fifteen
 * seconds for as long as the tab stayed open.
 */
const STOP_ASKING_AFTER_MS = 60 * 60 * 1000;

/** Whether a step of *this* run has been recorded since it started. */
function movedSinceStart(view: OnboardingView): boolean {
  // A retry keeps the last run's records and moves `startedAt` past them, so
  // they do not count as the worker having picked the retry up.
  const started = Date.parse(view.startedAt);
  return view.steps.some((step) => step.at !== null && Date.parse(step.at) >= started);
}

/**
 * The stall: a minute since the run started and not one step recorded. One
 * rule, read by the sentence and by the polling, so the card cannot say "you
 * can leave" while it keeps asking every three seconds.
 */
function stalled(view: OnboardingView, now: Date): boolean {
  return !movedSinceStart(view) && now.getTime() - Date.parse(view.startedAt) > STALL_AFTER_MS;
}

/**
 * A retry the queue has scheduled — or one that fell due within the last
 * minute, which a worker may be running now: `next_attempt_at` is only cleared
 * when the job finishes, so a retry in progress reads as a time just past.
 */
function retryScheduled(view: OnboardingView, now: Date): boolean {
  const retryAt = view.nextAttemptAt ? Date.parse(view.nextAttemptAt) : NaN;
  return Number.isFinite(retryAt) && retryAt >= now.getTime() - STALL_AFTER_MS;
}

/**
 * Whether "Retry connection" applies: an attempt that failed, or one still
 * `exchanged` past `LIVE_ATTEMPT_MS` with no retry coming.
 *
 * The second is the attempt whose job never ran or has died — the job's
 * enqueue failed after the row committed, or a worker was killed on its last
 * try. Nothing will move it, `retryOnboarding` reopens it (and refuses, saying
 * so, if a job for it is still queued), and without the button the only way
 * out was a new sign-in that threw the stored credential away.
 */
export function retryable(view: OnboardingView, now: Date): boolean {
  if (view.status === 'failed') return true;
  if (view.status !== 'exchanged') return false;
  return now.getTime() - Date.parse(view.startedAt) > LIVE_ATTEMPT_MS && !retryScheduled(view, now);
}

/**
 * Which recoveries the card offers: `retry` runs the job again with the stored
 * credential, `connect` is a new sign-in through Meta's window.
 *
 * A failed attempt always offers the sign-in, because some failures only a new
 * one fixes — the wrong number picked in the window, a bot channel on the
 * number — and the card cannot tell them from the sentence. It offers Retry
 * beside it only while a credential is stored: the job's first check refuses
 * an account without one, every time. A stalled attempt offers Retry alone; if
 * the credential has gone, the job's refusal says so and the card then offers
 * the sign-in.
 */
export function recoveryFor(
  view: OnboardingView,
  now: Date,
  hasCredential: boolean,
): { retry: boolean; connect: boolean } {
  if (view.status === 'failed') return { retry: hasCredential, connect: true };
  return { retry: retryable(view, now), connect: false };
}

/**
 * The lines the card prints under the step list while the attempt runs: the
 * queue's backoff, the stall sentence, or — past `LIVE_ATTEMPT_MS` with nothing
 * scheduled — what to press. Empty when there is nothing to say.
 *
 * The backoff line reads `last_transient_error`, which the job writes before
 * it rethrows (`./onboarding-complete`): without it the card would show a
 * spinner on `subscribe` for the two minutes until the retry.
 *
 * None of them promises the attempt "will continue": that holds only while a
 * job for it exists, which the page cannot see.
 */
export function describeOnboarding(view: OnboardingView, now: Date): string[] {
  if (view.status !== 'exchanged') return [];

  if (retryable(view, now)) {
    return [
      ...(view.lastTransientError ? [`The last try ended with: ${view.lastTransientError}.`] : []),
      'This connection has not finished in fifteen minutes and nothing is scheduled to carry it ' +
        'on. Press Retry connection: it runs the remaining steps with the credential saved at ' +
        "sign-in, without Meta's window. If a job for it is still queued, Retry says so, and the " +
        'worker is what needs looking at.',
    ];
  }

  if (view.lastTransientError) {
    const retryAt = view.nextAttemptAt ? Date.parse(view.nextAttemptAt) : NaN;
    const wait = Number.isFinite(retryAt) ? retryAt - now.getTime() : 0;
    return [`${view.lastTransientError} — retrying ${waitLabel(wait)}`];
  }

  if (stalled(view, now)) {
    return [
      "No worker has picked this up yet. The sign-in and its credential are saved, so Meta's " +
        'window is not needed again: if nothing moves within fifteen minutes of the start, Retry ' +
        'connection appears on this card.',
    ];
  }

  return [];
}

function waitLabel(ms: number): string {
  if (ms <= 1_000) return 'now';
  if (ms < 90_000) return `in ${Math.ceil(ms / 1_000)} s`;
  return `in ${Math.round(ms / 60_000)} min`;
}

/**
 * How long a contacts copy is watched after its request or its latest contact.
 * Contacts have no "done" signal: the phone sends the address book as a burst
 * of webhooks within minutes of the request when the Business app is open, and
 * nothing says the burst is over. Past this the row's badge is read on the next
 * page load like any other.
 */
const CONTACTS_WATCH_MS = 10 * 60 * 1000;

/** A contacts copy that was accepted and has moved within `CONTACTS_WATCH_MS`. */
function contactsArriving(coexistence: Coexistence, now: Date): boolean {
  const slot = coexistence.syncs.contacts;
  if (!slot || !('requestId' in slot) || !slot.requestId) return false;
  const lastMoved = Math.max(
    Date.parse(slot.requestedAt) || 0,
    slot.lastReceivedAt ? Date.parse(slot.lastReceivedAt) || 0 : 0,
  );
  return now.getTime() - lastMoved <= CONTACTS_WATCH_MS;
}

/**
 * A "Copy again" request the job has marked `sending` within the last minute.
 *
 * Bounded, because the marker outlives the request it marks: a targeted run
 * that fails transiently only rethrows, and the marker has to survive that —
 * it is how the next try reads Meta's "already requested" as its own earlier
 * request going through. Unbounded, it would poll every three seconds through
 * the whole backoff, or for as long as the card is shown.
 */
function copyRequestOut(view: OnboardingView, now: Date): boolean {
  return view.steps.some(
    (step) =>
      (step.step === 'contacts' || step.step === 'history') &&
      step.state === 'running' &&
      step.at !== null &&
      now.getTime() - Date.parse(step.at) <= STALL_AFTER_MS,
  );
}

/** During a backoff nothing can move until `next_attempt_at`; close to it, ask often. */
function backoffInterval(view: OnboardingView, now: Date): number {
  const retryAt = view.nextAttemptAt ? Date.parse(view.nextAttemptAt) : NaN;
  // The finite guard is not tidiness: `Date.parse(null)` is NaN, and a NaN
  // interval reaches `setInterval` as roughly zero.
  return Number.isFinite(retryAt) && retryAt - now.getTime() > SLOW_POLL_MS
    ? SLOW_POLL_MS
    : FAST_POLL_MS;
}

/**
 * How often the card asks the server again, or null when there is nothing
 * left to wait for. Two fixed values, never a computed one: the interval is an
 * effect dependency, and a number that changed on every render would rebuild
 * the scheduler on every refresh.
 *
 * Three seconds while the job is stepping, since each step lands on the row as
 * it finishes and a person is watching. Fifteen while it is only waiting: on a
 * backoff whose retry is more than fifteen seconds off, on a stall the card has
 * already told the admin about, and past `LIVE_ATTEMPT_MS` — still asking,
 * because a late worker can pick the job up, but not as if something were
 * about to land — until the attempt is `STOP_ASKING_AFTER_MS` past its start,
 * when Retry has been on the card for three quarters of an hour.
 *
 * Once connected: three seconds while a "Copy again" request is out, at the
 * backoff's pace while its retry is scheduled, fifteen while the phone sends the
 * history (which takes hours, in chunks) or a contacts copy is arriving, and
 * nothing once the attempt failed or every copy has gone quiet — a reconnect, a
 * declined history or a number not on the app has nothing to wait for.
 *
 * Every one of these is bounded by a time measured against `now`, so none of
 * them polls for ever: a running attempt is retryable once it is past
 * `LIVE_ATTEMPT_MS` with no retry scheduled, and a retryable one stops at
 * `STOP_ASKING_AFTER_MS`.
 */
export function pollIntervalMs(
  view: OnboardingView,
  coexistence: Coexistence | null,
  now: Date,
): number | null {
  if (view.status === 'exchanged') {
    if (retryable(view, now)) {
      return now.getTime() - Date.parse(view.startedAt) > STOP_ASKING_AFTER_MS
        ? null
        : SLOW_POLL_MS;
    }
    if (view.lastTransientError) return backoffInterval(view, now);
    return stalled(view, now) ? SLOW_POLL_MS : FAST_POLL_MS;
  }
  if (view.status !== 'connected') return null;

  // A targeted run ("Copy again") on a connected attempt writes the same
  // backoff columns, and `finish` clears them when it is done.
  if (view.lastTransientError && retryScheduled(view, now)) return backoffInterval(view, now);
  if (copyRequestOut(view, now)) return FAST_POLL_MS;
  if (!coexistence) return null;
  if (isSyncing(coexistence, now) || contactsArriving(coexistence, now)) return SLOW_POLL_MS;
  return null;
}

export type ConnectedFollowUp = {
  step: OnboardingStep;
  label: string;
  /** A step that succeeded with a warning, or one that failed. */
  kind: 'warning' | 'failed';
  text: string;
};

/**
 * The steps whose warning reports a fact rather than asking for something.
 *
 * The number step's warnings are what Meta says about the number — not on the
 * WhatsApp Business app, a platform other than CLOUD_API — or that it could not
 * be asked, and the job connects the number regardless
 * (`./onboarding-complete`'s `numberStep`). Nothing on this page or in Meta's
 * window changes any of them, so listing one under "Still to do" sent the admin
 * looking for a task that does not exist. The subscribe step's warning is the
 * opposite case: the app-level webhook fields are the one thing the job cannot
 * subscribe for itself, and `subscribe_meta_webhooks` is the fix. Every other
 * step warns about nothing today, so a warning added to one is a task until it
 * is argued into this set.
 */
const NOTE_ONLY_WARNINGS: ReadonlySet<OnboardingStep> = new Set(['number']);

/**
 * What a connected attempt says beyond "connected", split by whether a person
 * has to act on it.
 *
 * `todo` is every warning that asks for something — the subscribe step's
 * missing or unreadable webhook fields — and every step that failed, a copy
 * Meta refused among them. `notes` is every warning that only reports, which
 * the summary prints as it stands. Judged by the step that wrote the warning,
 * never by its wording. An empty `todo` is the only case in which the summary
 * may say there is nothing else to do; `notes` does not change that.
 */
export function connectedFollowUps(view: OnboardingView): {
  todo: ConnectedFollowUp[];
  notes: ConnectedFollowUp[];
} {
  const todo: ConnectedFollowUp[] = [];
  const notes: ConnectedFollowUp[] = [];
  for (const step of view.steps) {
    if (step.warning) {
      const item: ConnectedFollowUp = {
        step: step.step,
        label: step.label,
        kind: 'warning',
        text: step.warning,
      };
      (NOTE_ONLY_WARNINGS.has(step.step) ? notes : todo).push(item);
    }
    if (step.state === 'failed') {
      todo.push({
        step: step.step,
        label: step.label,
        kind: 'failed',
        text: step.sentence ?? 'This step failed.',
      });
    }
  }
  return { todo, notes };
}

/**
 * Whether the steps leave it unconfirmed that a reply typed on the phone
 * reaches a ticket: the number step or the subscribe step warned, or did not
 * finish. Judged by the step and never by the warning's wording — "could not
 * read this app's webhook fields" leaves it as unconfirmed as "not subscribed
 * to smb_message_echoes" does, and a number Meta says is not on the Business app
 * has no phone to type on.
 */
export function phoneRepliesUnconfirmed(view: OnboardingView): boolean {
  return view.steps.some(
    (step) =>
      (step.step === 'number' || step.step === 'subscribe') &&
      (step.warning !== null || step.state !== 'done'),
  );
}

/**
 * How long the page shows a connected attempt: a day — long enough for the
 * history to finish and for whoever started it to come back and read the
 * summary, short enough that the page is not a permanent log of every number
 * ever connected.
 */
export const SHOW_CONNECTED_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * How long the page shows a failed attempt nothing has replaced. A week, not a
 * day: the stored credential does not expire with the attempt, so Retry stays
 * useful long after the failure — and the failed card is the one recovery that
 * needs no popup, so hiding it soon would hide failures nobody has acted on.
 */
export const SHOW_FAILED_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether one attempt is still shown on its own terms: while it runs, for
 * `SHOW_CONNECTED_FOR_MS` after it connected, and for `SHOW_FAILED_FOR_MS`
 * after it failed. `shownOnboardings` adds the rule that needs its siblings.
 */
export function isOnboardingShown(view: OnboardingView, now: Date): boolean {
  if (view.status === 'exchanged') return true;
  const finished = view.finishedAt ? Date.parse(view.finishedAt) : Date.parse(view.startedAt);
  const shownFor = view.status === 'connected' ? SHOW_CONNECTED_FOR_MS : SHOW_FAILED_FOR_MS;
  return now.getTime() - finished <= shownFor;
}

/**
 * The number step's `outcome` when Meta listed the business account's numbers
 * and the attempt's was not among them — the wrong number picked in Meta's
 * window. Written by the job (`./onboarding-complete`'s `numberStep`), read by
 * `shownOnboardings`, so the page never has to judge the failure by its
 * sentence.
 */
export const NUMBER_NOT_ON_ACCOUNT = 'not_on_account';

/** Meta listed the account's numbers and this attempt's was not one of them. */
function numberNotOnAccount(view: OnboardingView): boolean {
  return view.steps.some(
    (step) =>
      step.step === 'number' && step.state === 'failed' && step.outcome === NUMBER_NOT_ON_ACCOUNT,
  );
}

/**
 * The attempts the page shows, out of every number's latest one.
 *
 * Beyond `isOnboardingShown`, one kind of failure is hidden once a later
 * attempt on the same business account connected: the number step's
 * `NUMBER_NOT_ON_ACCOUNT`, which is the wrong number picked in Meta's window
 * and then the right one. The page reads one attempt per phone number id, so
 * nothing ever replaced the wrong number's failure, and its Retry — which asks
 * Meta for the same list of numbers and gets the same answer — sat above the
 * working connection.
 *
 * Only that kind. A business account can hold two Business-app numbers, and
 * the credential is stored per account, so the second number connecting says
 * nothing about why the first failed: a job that gave up on a 5xx, a token
 * Meta refused, a bot channel on the number — each is one Retry may now fix
 * with the credential the second sign-in stored, and hiding it would leave a
 * fresh sign-in, which unlinks the phone's devices again, as the only way back.
 * The connected sibling is in the list however old it is, because the reader
 * keeps every number's latest attempt whatever its age.
 */
export function shownOnboardings(views: OnboardingView[], now: Date): OnboardingView[] {
  return views.filter((view) => {
    if (!isOnboardingShown(view, now)) return false;
    if (view.status !== 'failed' || !numberNotOnAccount(view)) return true;
    const started = Date.parse(view.startedAt);
    return !views.some(
      (other) =>
        other.id !== view.id &&
        other.wabaId === view.wabaId &&
        other.status === 'connected' &&
        Date.parse(other.startedAt) > started,
    );
  });
}
