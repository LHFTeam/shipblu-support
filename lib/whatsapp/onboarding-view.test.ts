import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, type OnboardingStepRecord } from '@/db/schema';
import { parseCoexistence } from './coexistence';
import {
  connectedFollowUps,
  describeOnboarding,
  isOnboardingShown,
  LIVE_ATTEMPT_MS,
  NUMBER_NOT_ON_ACCOUNT,
  type OnboardingRow,
  type OnboardingView,
  phoneRepliesUnconfirmed,
  pollIntervalMs,
  recoveryFor,
  retryable,
  SHOW_CONNECTED_FOR_MS,
  SHOW_FAILED_FOR_MS,
  shownOnboardings,
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
    const [stall] = describeOnboarding(view(), at(STALL_AFTER_MS + 1));
    expect(stall).toMatch(/^No worker has picked this up yet\./);
    expect(stall).toMatch(/Retry connection appears on this card/);
    // A job may not exist at all — its enqueue can fail after the row commits —
    // so the card must not promise the attempt carries on by itself.
    expect(stall).not.toMatch(/will continue/);
    // A step that landed since the start is a worker at work, however slow.
    expect(
      describeOnboarding(view({ steps: { number: ok(5_000) } }), at(STALL_AFTER_MS + 1)),
    ).toEqual([]);
  });

  /** Past the live window with nothing scheduled, the card says what to press. */
  it('names Retry once an attempt has sat for fifteen minutes with no retry coming', () => {
    const overdue = /not finished in fifteen minutes.*Press Retry connection/;

    // Moved, then stopped: no backoff line, no stall line, but no job either.
    const moved = view({ steps: { number: ok(5_000) } });
    expect(describeOnboarding(moved, at(LIVE_ATTEMPT_MS))).toEqual([]);
    expect(describeOnboarding(moved, at(LIVE_ATTEMPT_MS + 1))).toEqual([
      expect.stringMatching(overdue),
    ]);

    // A retry that fell due long ago: "retrying now" would have been printed for ever.
    const backedOff = view({
      steps: { number: ok(1_000) },
      lastTransientError: 'Meta answered 503: Service unavailable on subscribe',
      nextAttemptAt: at(130_000),
    });
    expect(describeOnboarding(backedOff, at(LIVE_ATTEMPT_MS + 1))).toEqual([
      'The last try ended with: Meta answered 503: Service unavailable on subscribe.',
      expect.stringMatching(overdue),
    ]);

    // A retry still scheduled is the queue's business, not the admin's.
    const scheduled = view({
      steps: { number: ok(1_000) },
      lastTransientError: 'Meta answered 503: Service unavailable on subscribe',
      nextAttemptAt: at(LIVE_ATTEMPT_MS + 120_000),
    });
    expect(describeOnboarding(scheduled, at(LIVE_ATTEMPT_MS + 1))).toEqual([
      'Meta answered 503: Service unavailable on subscribe — retrying in 2 min',
    ]);
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

describe('retryable and recoveryFor', () => {
  /** The same fifteen minutes `retryOnboarding` measures liveness by. */
  it('offers Retry on a failure, and on an attempt past the live window with no retry coming', () => {
    expect(retryable(view({ status: 'failed' }), at(0))).toBe(true);
    expect(retryable(view(), at(LIVE_ATTEMPT_MS))).toBe(false);
    expect(retryable(view(), at(LIVE_ATTEMPT_MS + 1))).toBe(true);
    expect(retryable(view({ status: 'connected' }), at(10 * LIVE_ATTEMPT_MS))).toBe(false);

    // A retry the queue has scheduled, or one that fell due a moment ago and
    // may be running now, is not the admin's to start.
    const scheduled = view({
      lastTransientError: 'x',
      nextAttemptAt: at(LIVE_ATTEMPT_MS + 60_000),
    });
    expect(retryable(scheduled, at(LIVE_ATTEMPT_MS + 1))).toBe(false);
    expect(retryable(scheduled, at(LIVE_ATTEMPT_MS + 60_000 + STALL_AFTER_MS))).toBe(false);
    expect(retryable(scheduled, at(LIVE_ATTEMPT_MS + 60_000 + STALL_AFTER_MS + 1))).toBe(true);
  });

  /**
   * Retry cannot fix the wrong number picked in Meta's window, and a new
   * sign-in unlinks the phone's devices again — so a failure offers both, and
   * Retry only while there is a credential for the job to use.
   */
  it('offers a new sign-in beside Retry on a failure, and Retry only with a credential', () => {
    const failed = view({ status: 'failed', error: 'Number is not on business account' });
    expect(recoveryFor(failed, at(0), true)).toEqual({ retry: true, connect: true });
    expect(recoveryFor(failed, at(0), false)).toEqual({ retry: false, connect: true });

    expect(recoveryFor(view(), at(0), true)).toEqual({ retry: false, connect: false });
    expect(recoveryFor(view(), at(LIVE_ATTEMPT_MS + 1), true)).toEqual({
      retry: true,
      connect: false,
    });
    expect(recoveryFor(view({ status: 'connected' }), at(0), true)).toEqual({
      retry: false,
      connect: false,
    });
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

  /** During a backoff nothing can move until `next_attempt_at`. */
  it('slows down through a backoff, and speeds up as the retry comes due', () => {
    const backingOff = (nextAttemptAt: Date | null) =>
      view({
        steps: { number: ok(1_000) },
        lastTransientError: 'Meta answered 503',
        nextAttemptAt,
      });
    expect(pollIntervalMs(backingOff(at(170_000)), null, at(10_000))).toBe(15_000);
    expect(pollIntervalMs(backingOff(at(20_000)), null, at(10_000))).toBe(3_000);
    // The retry is due, so a worker may be running it now.
    expect(pollIntervalMs(backingOff(at(5_000)), null, at(10_000))).toBe(3_000);
    // A missing time is not a NaN interval, which `setInterval` reads as zero.
    expect(pollIntervalMs(backingOff(null), null, at(10_000))).toBe(3_000);
  });

  it('slows down once the card has said nothing is moving, without stopping', () => {
    expect(pollIntervalMs(view(), null, at(STALL_AFTER_MS))).toBe(3_000);
    expect(pollIntervalMs(view(), null, at(STALL_AFTER_MS + 1))).toBe(15_000);
    expect(
      pollIntervalMs(view({ steps: { number: ok(STALL_AFTER_MS) } }), null, at(STALL_AFTER_MS + 1)),
    ).toBe(3_000);
    // Past the live window a late worker can still pick the job up.
    expect(
      pollIntervalMs(view({ steps: { number: ok(1_000) } }), null, at(LIVE_ATTEMPT_MS + 1)),
    ).toBe(15_000);
  });

  /** An attempt whose job is gone was asked about every fifteen seconds for as long as the tab stayed open. */
  it('stops asking about an attempt Retry applies to an hour after it started', () => {
    const HOUR = 60 * 60 * 1000;
    expect(pollIntervalMs(view(), null, at(HOUR))).toBe(15_000);
    expect(pollIntervalMs(view(), null, at(HOUR + 1))).toBeNull();
    // A retry the queue has scheduled is still waited for, however old the attempt.
    const scheduled = view({
      lastTransientError: 'Meta answered 503',
      nextAttemptAt: at(HOUR + 120_000),
    });
    expect(pollIntervalMs(scheduled, null, at(HOUR + 1))).toBe(15_000);
    expect(pollIntervalMs(scheduled, null, at(HOUR + 120_000 + STALL_AFTER_MS + 1))).toBeNull();
    // Retry moves the start, which is what starts the asking again.
    expect(pollIntervalMs(view({ startedAt: at(HOUR) }), null, at(HOUR + 1))).toBe(3_000);
  });

  /**
   * "Copy again" answers before the worker claims the job, so the request id
   * is not there yet; the job's own `sending` mark is what the card polls on —
   * for a minute, because the mark deliberately outlives a failed request.
   */
  it('polls while a "Copy again" request is out, for a bounded time', () => {
    const asking = (ms: number) =>
      view({
        status: 'connected',
        steps: {
          number: ok(1_000),
          history: { at: iso(ms), ok: false, outcome: 'sending', detail: 'Asking the phone.' },
        },
      });
    expect(pollIntervalMs(asking(600_000), coexistence(), at(600_000 + 5_000))).toBe(3_000);
    expect(
      pollIntervalMs(asking(600_000), coexistence(), at(600_000 + STALL_AFTER_MS + 1)),
    ).toBeNull();

    // Its retry, scheduled by the queue, is followed at the backoff's pace.
    const retrying = toOnboardingView(
      row({
        status: 'connected',
        lastTransientError: 'Meta answered 503',
        nextAttemptAt: at(600_000 + 160_000),
        steps: { history: { at: iso(600_000), ok: false, outcome: 'sending' } },
      }),
      ONBOARDING_STEPS,
    );
    expect(pollIntervalMs(retrying, coexistence(), at(600_000 + 120_000))).toBe(15_000);
  });

  /** Contacts have no "done" signal, so they are watched while they move. */
  it('watches a contacts copy for ten minutes after it last moved', () => {
    const contacts = (lastReceivedAt?: string) =>
      coexistence({
        contacts: { requestId: 'c', requestedAt: iso(0), received: 3, lastReceivedAt },
      });
    const connected = view({ status: 'connected' });
    expect(pollIntervalMs(connected, contacts(), at(60_000))).toBe(15_000);
    expect(pollIntervalMs(connected, contacts(), at(10 * 60_000 + 1))).toBeNull();
    expect(pollIntervalMs(connected, contacts(iso(9 * 60_000)), at(10 * 60_000 + 1))).toBe(15_000);
  });
});

describe('connectedFollowUps and phoneRepliesUnconfirmed', () => {
  const clean = {
    number: ok(1_000, '+20 10 1234 5678 · ShipBlu'),
    subscribe: ok(2_000),
    channel: ok(3_000),
    contacts: ok(4_000),
    history: ok(5_000),
    templates: ok(6_000),
  };
  const connected = (steps: Partial<Record<keyof typeof clean, OnboardingStepRecord>>) =>
    view({ status: 'connected', steps: { ...clean, ...steps } });

  it('has nothing to add to a connection where every step went through', () => {
    expect(connectedFollowUps(connected({}))).toEqual({ todo: [], notes: [] });
    expect(phoneRepliesUnconfirmed(connected({}))).toBe(false);
  });

  /** "Nothing else to do" under this warning sent the admin away from the one thing left. */
  it('names the subscribe warning, and stops vouching for phone replies', () => {
    const warned = connected({
      subscribe: {
        at: iso(2_000),
        ok: true,
        warning: 'This app is not subscribed to smb_message_echoes for WhatsApp',
      },
    });
    expect(connectedFollowUps(warned)).toEqual({
      todo: [
        {
          step: 'subscribe',
          label: STEP_LABELS.subscribe,
          kind: 'warning',
          text: 'This app is not subscribed to smb_message_echoes for WhatsApp',
        },
      ],
      notes: [],
    });
    expect(phoneRepliesUnconfirmed(warned)).toBe(true);
  });

  /** Judged by the step, never by the warning's wording. */
  it('asks for an unreadable subscription as for a missing one', () => {
    const unread = connected({
      subscribe: {
        at: iso(2_000),
        ok: true,
        warning: "Could not read this app's webhook fields to check them: timeout.",
      },
    });
    expect(phoneRepliesUnconfirmed(unread)).toBe(true);
    expect(connectedFollowUps(unread).todo).toHaveLength(1);
  });

  /**
   * What Meta says about the number is a note: nothing on the page changes it,
   * and listing it under "Still to do" sent the admin looking for a task.
   */
  it('keeps every number-step warning out of the to-do list, whatever it says', () => {
    for (const warning of [
      'Meta says this number is not on the WhatsApp Business app, so it is connected as a Cloud API number with no phone to copy history from.',
      "Meta reports the number's platform as ON_PREMISE, not CLOUD_API, so sending from it may not work yet.",
      'Could not confirm the number is on the WhatsApp Business app: timeout.',
    ]) {
      const noted = connected({ number: { at: iso(1_000), ok: true, warning } });
      expect(connectedFollowUps(noted)).toEqual({
        todo: [],
        notes: [{ step: 'number', label: STEP_LABELS.number, kind: 'warning', text: warning }],
      });
      // Still not vouched for: a number not on the app has no phone to type on.
      expect(phoneRepliesUnconfirmed(noted)).toBe(true);
    }

    // A note beside a task leaves the task where it was.
    const both = connected({
      number: { at: iso(1_000), ok: true, warning: 'Meta says this number is not on the app' },
      subscribe: { at: iso(2_000), ok: true, warning: 'Not subscribed to history' },
    });
    expect(connectedFollowUps(both).todo.map((item) => item.step)).toEqual(['subscribe']);
    expect(connectedFollowUps(both).notes.map((item) => item.step)).toEqual(['number']);
  });

  it('names a copy Meta refused, which does not touch phone replies', () => {
    const refused = connected({ contacts: failed(4_000, 'Meta refused: asked too late') });
    expect(connectedFollowUps(refused)).toEqual({
      todo: [
        {
          step: 'contacts',
          label: STEP_LABELS.contacts,
          kind: 'failed',
          text: 'Meta refused: asked too late',
        },
      ],
      notes: [],
    });
    expect(phoneRepliesUnconfirmed(refused)).toBe(false);
  });
});

describe('isOnboardingShown and shownOnboardings', () => {
  it('shows a running attempt always, a connected one for a day and a failed one for a week', () => {
    expect(isOnboardingShown(view(), at(10 * SHOW_FAILED_FOR_MS))).toBe(true);

    const connected = view({ status: 'connected', finishedAt: at(5_000) });
    expect(isOnboardingShown(connected, at(5_000 + SHOW_CONNECTED_FOR_MS))).toBe(true);
    expect(isOnboardingShown(connected, at(5_000 + SHOW_CONNECTED_FOR_MS + 1))).toBe(false);

    const failure = view({ status: 'failed', error: 'x', finishedAt: at(5_000) });
    expect(isOnboardingShown(failure, at(5_000 + SHOW_CONNECTED_FOR_MS + 1))).toBe(true);
    expect(isOnboardingShown(failure, at(5_000 + SHOW_FAILED_FOR_MS))).toBe(true);
    expect(isOnboardingShown(failure, at(5_000 + SHOW_FAILED_FOR_MS + 1))).toBe(false);
    // Measured from the start when the finish was never recorded.
    expect(
      isOnboardingShown(view({ status: 'failed', error: 'x' }), at(SHOW_FAILED_FOR_MS + 1)),
    ).toBe(false);
  });

  /** The wrong number picked in Meta's window, then the right one: one id each. */
  it('hides a wrong-number failure once a later attempt on the same business account connected', () => {
    const notOnAccount = 'Number 1098 is not on business account 102030405060';
    const wrongNumber: OnboardingView = view({
      id: 'o-wrong',
      status: 'failed',
      error: notOnAccount,
      steps: {
        number: { ...failed(5_000, notOnAccount), outcome: NUMBER_NOT_ON_ACCOUNT },
      },
      phoneNumberId: '1098',
      finishedAt: at(10_000),
    });
    const rightNumber = (overrides: Partial<OnboardingRow>) =>
      view({
        id: 'o-right',
        status: 'connected',
        phoneNumberId: '2099',
        startedAt: at(600_000),
        finishedAt: at(660_000),
        ...overrides,
      });
    const now = at(700_000);

    expect(shownOnboardings([rightNumber({}), wrongNumber], now).map((v) => v.id)).toEqual([
      'o-right',
    ]);
    // Another business account's connection says nothing about this failure.
    expect(
      shownOnboardings([rightNumber({ wabaId: '999' }), wrongNumber], now).map((v) => v.id),
    ).toEqual(['o-right', 'o-wrong']);
    // Nor does one that started before it: the failure is the newer word.
    expect(
      shownOnboardings([rightNumber({ startedAt: at(-60_000) }), wrongNumber], now).map(
        (v) => v.id,
      ),
    ).toEqual(['o-right', 'o-wrong']);
    // A connection still running is not a connection yet.
    expect(
      shownOnboardings([rightNumber({ status: 'exchanged', finishedAt: null }), wrongNumber], now)
        .length,
    ).toBe(2);
    // The connected sibling counts even after its own card has gone.
    expect(
      shownOnboardings([rightNumber({}), wrongNumber], at(660_000 + SHOW_CONNECTED_FOR_MS + 1)),
    ).toEqual([]);
  });

  /**
   * One business account, two Business-app numbers, one credential between
   * them: the second connecting is no answer to why the first failed, and the
   * first's Retry — which uses the credential the second sign-in stored — may
   * now go through. Hiding it left a fresh sign-in as the only way back.
   */
  it('keeps every other failure beside a connection on the same business account', () => {
    const second = view({
      id: 'o-second',
      status: 'connected',
      phoneNumberId: '2099',
      startedAt: at(600_000),
      finishedAt: at(660_000),
    });
    const failures: Partial<OnboardingRow>[] = [
      // The queue gave up on a 5xx: no step records a failure at all.
      {
        steps: { number: ok(1_000) },
        error:
          'Meta answered 503: Service temporarily unavailable on subscribe — gave up after 5 attempts',
      },
      // Meta refused the stored token on the first call, which is the number step.
      {
        steps: { number: failed(1_000, 'The stored credential was refused') },
        error: 'The stored credential was refused',
      },
      // The number is the bot's channel, which is changed on this page.
      {
        steps: {
          number: ok(1_000),
          subscribe: ok(2_000),
          channel: failed(3_000, "Number 1098 is the customer bot's channel"),
        },
        error: "Number 1098 is the customer bot's channel",
      },
    ];
    for (const overrides of failures) {
      const first = view({
        id: 'o-first',
        status: 'failed',
        phoneNumberId: '1098',
        finishedAt: at(10_000),
        ...overrides,
      });
      expect(shownOnboardings([second, first], at(700_000)).map((v) => v.id)).toEqual([
        'o-second',
        'o-first',
      ]);
    }
  });
});
