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
  /** Something the step did, that still needs a person — the app-level webhook fields. */
  warning: string | null;
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
 * worker is up, so a minute of nothing is a worker that is down or busy —
 * and either way the admin can leave, because the row and the credential are
 * already saved.
 */
export const STALL_AFTER_MS = 60_000;

/**
 * The lines the card prints under the step list while the attempt runs: the
 * queue's backoff, or the stall sentence. Empty when there is nothing to say.
 *
 * The backoff line reads `last_transient_error`, which the job writes before
 * it rethrows (`./onboarding-complete`): without it the card would show a
 * spinner on `subscribe` for the two minutes until the retry.
 */
export function describeOnboarding(view: OnboardingView, now: Date): string[] {
  if (view.status !== 'exchanged') return [];

  if (view.lastTransientError) {
    const retryAt = view.nextAttemptAt ? Date.parse(view.nextAttemptAt) : NaN;
    const wait = Number.isFinite(retryAt) ? retryAt - now.getTime() : 0;
    return [`${view.lastTransientError} — retrying ${waitLabel(wait)}`];
  }

  // Movement since *this* run started: a retry keeps the last run's records
  // and moves `startedAt` past them, so they do not count as the worker
  // having picked the retry up.
  const started = Date.parse(view.startedAt);
  const moved = view.steps.some((step) => step.at !== null && Date.parse(step.at) >= started);
  if (!moved && now.getTime() - started > STALL_AFTER_MS) {
    return [
      'No worker has picked this up yet — the connection is saved and will continue; you can ' +
        'leave this page.',
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
 * How often the card asks the server again, or null when there is nothing
 * left to wait for.
 *
 * Three seconds while the job runs, since each step lands on the row as it
 * finishes and a person is watching; fifteen while the phone sends the
 * history, which takes hours and moves in chunks; nothing once the attempt
 * failed, or connected with the copy done — or with no copy to wait for, which
 * is a reconnect, a declined history or a number not on the app.
 */
export function pollIntervalMs(
  view: OnboardingView,
  coexistence: Coexistence | null,
  now: Date,
): number | null {
  if (view.status === 'exchanged') return 3_000;
  if (view.status === 'connected' && coexistence && isSyncing(coexistence, now)) return 15_000;
  return null;
}

/**
 * Whether the page still shows the attempt: while it runs, while it has
 * failed (the retry button lives on the card), and for a day after it
 * connected — long enough for the history to finish and for whoever started
 * it to come back and read the summary, short enough that the page is not a
 * permanent log of every number ever connected.
 */
export const SHOW_CONNECTED_FOR_MS = 24 * 60 * 60 * 1000;

export function isOnboardingShown(view: OnboardingView, now: Date): boolean {
  if (view.status !== 'connected') return true;
  const finished = view.finishedAt ? Date.parse(view.finishedAt) : Date.parse(view.startedAt);
  return now.getTime() - finished <= SHOW_CONNECTED_FOR_MS;
}
