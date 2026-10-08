import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, type OnboardingStepRecord } from '@/db/schema';
import { parseCoexistence } from './coexistence';
import {
  describeOnboarding,
  isOnboardingShown,
  type OnboardingRow,
  pollIntervalMs,
  SHOW_CONNECTED_FOR_MS,
  STALL_AFTER_MS,
  STEP_LABELS,
  toOnboardingView,
} from './onboarding-view';

/**
 * The card is the only account an admin gets of a job running somewhere
 * else, so what it reads off the row has to be right in the states where the
 * row is ambiguous: which step is running, whether a retry has been picked
 * up, and when to stop asking.
 */

const STARTED = new Date('2026-10-08T10:00:00.000Z');
const at = (ms: number) => new Date(STARTED.getTime() + ms);
const iso = (ms: number) => at(ms).toISOString();

const ok = (ms: number, detail?: string): OnboardingStepRecord => ({
  at: iso(ms),
  ok: true,
  detail,
});
const failed = (ms: number, error: string): OnboardingStepRecord => ({
  at: iso(ms),
  ok: false,
  error,
});

const row = (overrides: Partial<OnboardingRow> = {}): OnboardingRow => ({
  id: 'o-1',
  status: 'exchanged',
  steps: {},
  attempts: 0,
  nextAttemptAt: null,
  lastTransientError: null,
  error: null,
  channelId: null,
  phoneNumberId: '109876543210',
  wabaId: '102030405060',
  startedAt: STARTED,
  finishedAt: null,
  startedByLabel: 'Mona Admin',
  ...overrides,
});

const view = (overrides: Partial<OnboardingRow> = {}) =>
  toOnboardingView(row(overrides), ONBOARDING_STEPS);

const states = (overrides: Partial<OnboardingRow> = {}) =>
  Object.fromEntries(view(overrides).steps.map((step) => [step.step, step.state]));

describe('toOnboardingView', () => {
  it('labels every step the job records, in the schema order', () => {
    const steps = view().steps;
    expect(steps.map((step) => step.step)).toEqual([...ONBOARDING_STEPS]);
    for (const step of steps) expect(step.label).toBe(STEP_LABELS[step.step]);
  });

  it('points at the step the job is on', () => {
    // Nothing recorded yet: the first step is where the job starts.
    expect(states()).toMatchObject({ number: 'running', subscribe: 'pending' });
    // After the last recorded step, when that step succeeded.
    expect(states({ steps: { number: ok(1_000), subscribe: ok(2_000) } })).toMatchObject({
      number: 'done',
      subscribe: 'done',
      channel: 'running',
      contacts: 'pending',
    });
    // A request that is out is running whatever else is recorded.
    expect(
      states({
        steps: {
          number: ok(1_000),
          subscribe: ok(2_000),
          channel: ok(3_000),
          contacts: { at: iso(4_000), ok: false, outcome: 'sending', detail: 'Asking the phone.' },
        },
      }),
    ).toMatchObject({ contacts: 'running', history: 'pending' });
  });

  /** A retry runs the step that failed again; the card must not point past it. */
  it('shows a failed step as running again once the attempt is retried', () => {
    const steps = { number: ok(1_000), subscribe: failed(2_000, 'Meta refused') };
    expect(states({ status: 'failed', steps, error: 'Meta refused' })).toMatchObject({
      subscribe: 'failed',
      channel: 'pending',
    });
    expect(states({ status: 'exchanged', steps })).toMatchObject({
      subscribe: 'running',
      channel: 'pending',
    });
  });

  it('carries a step’s own words and warnings, and the row’s instants as strings', () => {
    const connected = view({
      status: 'connected',
      steps: {
        number: ok(1_000, '+20 10 1234 5678 · ShipBlu'),
        subscribe: { at: iso(2_000), ok: true, warning: 'This app is not subscribed to history' },
        channel: ok(3_000, 'Created channel "ShipBlu".'),
        contacts: failed(4_000, 'The contacts were already requested'),
        history: ok(5_000),
        templates: ok(6_000),
      },
      channelId: 'c-1',
      finishedAt: at(6_000),
      nextAttemptAt: at(7_000),
    });
    expect(connected.steps.map((step) => step.sentence)).toEqual([
      '+20 10 1234 5678 · ShipBlu',
      null,
      'Created channel "ShipBlu".',
      'The contacts were already requested',
      null,
      null,
    ]);
    expect(connected.steps[1]?.warning).toMatch(/not subscribed/);
    expect(connected).toMatchObject({
      startedAt: STARTED.toISOString(),
      finishedAt: iso(6_000),
      nextAttemptAt: iso(7_000),
      channelId: 'c-1',
    });
  });
});

describe('describeOnboarding', () => {
  it('reads the queue’s backoff off the row instead of showing a spinner', () => {
    const backing = view({
      steps: { number: ok(1_000) },
      lastTransientError: 'Meta answered 503: Service unavailable on subscribe',
      nextAttemptAt: at(130_000),
      attempts: 1,
    });
    expect(describeOnboarding(backing, at(10_000))).toEqual([
      'Meta answered 503: Service unavailable on subscribe — retrying in 2 min',
    ]);
    expect(describeOnboarding(backing, at(100_000))).toEqual([
      'Meta answered 503: Service unavailable on subscribe — retrying in 30 s',
    ]);
    expect(describeOnboarding(backing, at(200_000))[0]).toMatch(/retrying now$/);
  });

  it('says a worker has not picked the attempt up after a minute of nothing', () => {
    expect(describeOnboarding(view(), at(STALL_AFTER_MS))).toEqual([]);
    expect(describeOnboarding(view(), at(STALL_AFTER_MS + 1))).toEqual([
      'No worker has picked this up yet — the connection is saved and will continue; you can leave this page.',
    ]);
    // A step that landed since the start is a worker at work, however slow.
    expect(
      describeOnboarding(view({ steps: { number: ok(5_000) } }), at(STALL_AFTER_MS + 1)),
    ).toEqual([]);
  });

  /** A retry moves `startedAt` past the last run's records, which must not count as movement. */
  it('does not read the last run’s steps as the retry having started', () => {
    const retried = view({
      startedAt: at(600_000),
      steps: { number: ok(1_000), subscribe: failed(2_000, 'Meta refused') },
    });
    expect(describeOnboarding(retried, at(600_000 + STALL_AFTER_MS + 1))).toHaveLength(1);
  });

  it('says nothing once the attempt is final', () => {
    expect(describeOnboarding(view({ status: 'failed', error: 'x' }), at(999_999))).toEqual([]);
    expect(
      describeOnboarding(
        view({ status: 'connected', lastTransientError: 'stale', nextAttemptAt: at(1) }),
        at(999_999),
      ),
    ).toEqual([]);
  });
});

describe('pollIntervalMs', () => {
  const coexistence = (syncs = {}) =>
    parseCoexistence({
      coexistence: {
        onboardedAt: STARTED.toISOString(),
        wabaId: '102030405060',
        displayPhoneNumber: '+20 10 1234 5678',
        verifiedName: 'ShipBlu',
        subscribedAt: null,
        syncs,
      },
    });

  it('asks every three seconds while the job runs, every fifteen while the phone sends, then stops', () => {
    expect(pollIntervalMs(view(), null, at(0))).toBe(3_000);
    expect(
      pollIntervalMs(
        view({ status: 'connected' }),
        coexistence({ history: { requestId: 'r', requestedAt: iso(0) } }),
        at(60_000),
      ),
    ).toBe(15_000);
    expect(
      pollIntervalMs(
        view({ status: 'connected' }),
        coexistence({
          history: {
            requestId: 'r',
            requestedAt: iso(0),
            progressByPhase: { 0: 100, 1: 100, 2: 100 },
          },
        }),
        at(60_000),
      ),
    ).toBeNull();
    // Connected with nothing requested — a reconnect — has nothing to wait for.
    expect(pollIntervalMs(view({ status: 'connected' }), coexistence(), at(60_000))).toBeNull();
    expect(pollIntervalMs(view({ status: 'connected' }), null, at(60_000))).toBeNull();
    expect(pollIntervalMs(view({ status: 'failed' }), null, at(60_000))).toBeNull();
  });
});

describe('isOnboardingShown', () => {
  it('shows a running or failed attempt always, and a connected one for a day', () => {
    expect(isOnboardingShown(view(), at(10 * SHOW_CONNECTED_FOR_MS))).toBe(true);
    expect(isOnboardingShown(view({ status: 'failed' }), at(10 * SHOW_CONNECTED_FOR_MS))).toBe(
      true,
    );
    const connected = view({ status: 'connected', finishedAt: at(5_000) });
    expect(isOnboardingShown(connected, at(5_000 + SHOW_CONNECTED_FOR_MS))).toBe(true);
    expect(isOnboardingShown(connected, at(5_000 + SHOW_CONNECTED_FOR_MS + 1))).toBe(false);
  });
});
