/**
 * The browser half of connecting a WhatsApp Business-app number: what Meta's
 * JavaScript SDK is asked for, and what its window says back.
 *
 * Pure and client-safe. Everything the popup returns is a *claim* — the server
 * proves the code by exchanging it and the ids by reading them with the token
 * (`./onboarding`) — so this module only has to get three things right: open
 * the window with the options Meta documents, take a message from Meta's own
 * origin and nobody else's, and read the three events the window sends without
 * ever throwing in a `message` listener.
 *
 * It also holds the connect card's phase machine and the two pieces of SDK
 * plumbing the card leans on — seeing whether the browser refused the window,
 * and sharing the SDK's one `fbAsyncInit` between cards. They are here rather
 * than in the card because each is a rule with a way to be wrong that only
 * shows in a browser, and the card is a `'use client'` file a node test cannot
 * import; here, the test beside this file runs them.
 *
 * Verified against Meta's Embedded Signup and coexistence pages on 2026-10-08.
 * Where the pages disagree (there are two generations of them), the constants
 * below say which one they follow, and the test beside this file pins them.
 */

import { GRAPH_VERSION } from '@/lib/meta/graph';

/** Loaded once per document, when the connect card opens — never on the click. */
export const FB_SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

/** The `type` every Embedded Signup `postMessage` carries. */
export const SIGNUP_MESSAGE_TYPE = 'WA_EMBEDDED_SIGNUP';

/**
 * The three events the window posts, by what they mean here.
 *
 * The coexistence guide names the finish event for the Business-app flow
 * `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`; the plain `FINISH` is the standard
 * flow's. Both are read as "finished": which flow ran is the login
 * configuration's decision, not the browser's, and the server treats the ids
 * either way as claims it proves — a number that turns out not to be on the
 * Business app is recorded as such by the job's `number` step.
 */
export const SIGNUP_EVENTS = {
  finished: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  finishedStandard: 'FINISH',
  cancelled: 'CANCEL',
  error: 'ERROR',
} as const;

/**
 * The `extras` handed to `FB.login`, which is what turns a Facebook login into
 * Embedded Signup for a number on the WhatsApp Business app.
 *
 * **Re-check these against the App Dashboard's Embedded Signup Builder before
 * relying on them.** The custom-flow page for the Business-app onboarding
 * shows v3 extras — `featureType` and `sessionInfoVersion: '3'` — while the
 * versions page says v4 selects the product in the login configuration and
 * takes `extras: {}`, listing `whatsapp_business_app_onboarding` for v4 as
 * well. The Builder generates the snippet for whichever version the app is on,
 * and that snippet is the authority; this is the v3 shape, in one constant so
 * adopting the Builder's is one edit. v2 retires on 2026-10-15.
 */
export const EMBEDDED_SIGNUP_EXTRAS = {
  setup: {},
  featureType: 'whatsapp_business_app_onboarding',
  sessionInfoVersion: '3',
} as const;

/** How long the browser waits for the finish event once the code is in hand. */
export const FINISH_WAIT_MS = 2_000;

/** How long the SDK may take to arrive before the card says it was blocked. */
export const SDK_LOAD_TIMEOUT_MS = 10_000;

/**
 * A login callback this soon after the click, with no code and no message, is
 * worded as a blocked window.
 *
 * Not how an ordinary pop-up blocker shows itself: when `window.open` answers
 * null the SDK logs it and stops — no window is registered, no monitor runs and
 * the callback never comes — so that case is seen during the click by
 * `watchWindowOpen` instead. A callback with no code is always a window that
 * opened and then shut, noticed by the SDK's 100 ms monitor. Shut within a
 * second of opening, that is a blocker extension that lets `window.open`
 * succeed and closes what it opened, or a very fast cancel; the recovery is the
 * same either way — allow pop-ups and press again.
 */
export const POPUP_BLOCKED_MS = 1_000;

export type WindowOpenOutcome = 'opened' | 'blocked' | 'not_called';

/**
 * Runs `run` — the `FB.login` call — and reports what `window.open` answered
 * while it ran.
 *
 * The SDK opens Meta's window synchronously inside `FB.login` (that is why the
 * call has to be inside the click), and says nothing at all when the browser
 * refuses it: the callback is simply never called. So the refusal can only be
 * seen here, as `window.open` returning null during the call. `not_called`
 * means the SDK opened nothing synchronously — a future SDK that opens later,
 * or another sign-in path — and the card cannot tell either way.
 *
 * The original is called with its own `this` (`apply(target, …)`): the native
 * `window.open` invoked on anything else throws "Illegal invocation". And it is
 * put back in `finally`, so a throwing `run` cannot leave the page's
 * `window.open` wrapped.
 */
export function watchWindowOpen(
  target: { open: Window['open'] },
  run: () => void,
): WindowOpenOutcome {
  const native = target.open;
  let outcome: WindowOpenOutcome = 'not_called';
  target.open = (...args) => {
    const opened = native.apply(target, args);
    outcome = opened ? 'opened' : 'blocked';
    return opened;
  };
  try {
    run();
  } finally {
    target.open = native;
  }
  return outcome;
}

type SdkInitOptions = {
  appId: string;
  autoLogAppEvents: boolean;
  xfbml: boolean;
  version: string;
};

/** The two globals the SDK reads and writes, as the gate needs them. */
type SdkHost = {
  FB?: { init(options: SdkInitOptions): void };
  fbAsyncInit?: () => void;
};

type SdkWaiter = { ready: () => void; blocked: () => void };

/**
 * One `fbAsyncInit` for every connect card in the document.
 *
 * The SDK calls `window.fbAsyncInit` exactly once, when it loads, and marks it
 * `hasRun`. The page can hold several cards — the header's, an account row's,
 * a channel row's — and a card that assigned its own closure would lose to
 * whichever card assigned last: its `sdk_ready` would never come, and its
 * timeout would say the SDK was blocked while the card beside it used it. So
 * each card waits here, and whichever closure the SDK calls initialises the SDK
 * once and wakes every waiter. Every card hands the same app id, from the same
 * readiness, so which closure wins does not matter.
 *
 * `fail` is the script's `error` event, which only the card that injected the
 * tag hears. Waiters are told and kept: the tag comes down on an error, a card
 * opened later injects it again, and a load that succeeds then still wakes the
 * cards that were told it failed.
 */
export function createSdkGate() {
  let initialised = false;
  const waiting = new Set<SdkWaiter>();

  return {
    /** Whether `FB.init` has run in this document. */
    get initialised() {
      return initialised;
    },

    /** Wakes `waiter` once the SDK is initialised; the answer unsubscribes it. */
    wait(host: SdkHost, appId: string, waiter: SdkWaiter): () => void {
      if (initialised) {
        waiter.ready();
        return () => undefined;
      }
      waiting.add(waiter);
      host.fbAsyncInit = () => {
        const fb = host.FB;
        if (!fb) return;
        fb.init({ appId, autoLogAppEvents: true, xfbml: true, version: GRAPH_VERSION });
        initialised = true;
        const woken = [...waiting];
        waiting.clear();
        for (const each of woken) each.ready();
      };
      return () => {
        waiting.delete(waiter);
      };
    },

    fail() {
      for (const each of [...waiting]) each.blocked();
    },
  };
}

// --- The connect card's phases ----------------------------------------------

export type ConnectPhase =
  | { name: 'loading_sdk' }
  /** `timeout`: not arrived yet, and may still. `error`: the script failed to load. */
  | { name: 'sdk_blocked'; cause: 'timeout' | 'error' }
  /** `wait`: refused for something running Meta's window again cannot fix. */
  | { name: 'idle'; error: string | null; wait: boolean }
  /** `unseen`: the SDK opened nothing during the click, so the card cannot tell. */
  | { name: 'popup_open'; unseen: boolean }
  | { name: 'popup_blocked' }
  | { name: 'cancelled'; step: string | null }
  | { name: 'meta_error'; message: string | null; sessionId: string | null }
  | { name: 'awaiting_number' }
  | { name: 'no_number' }
  | { name: 'finishing' }
  | { name: 'unanswered' }
  | { name: 'done'; notice: string };

export type ConnectEvent =
  | { type: 'sdk_ready' }
  | { type: 'sdk_blocked'; cause: 'timeout' | 'error' }
  | { type: 'opened' }
  | { type: 'window_unseen' }
  | { type: 'popup_blocked' }
  | { type: 'closed' }
  | { type: 'cancelled'; step: string | null }
  | { type: 'meta_error'; message: string | null; sessionId: string | null }
  | { type: 'awaiting_number' }
  | { type: 'no_number' }
  | { type: 'finishing' }
  | { type: 'refused'; error: string; wait: boolean }
  | { type: 'unanswered' }
  | { type: 'done'; notice: string };

/** The phases in which Meta's window is open and may still say something. */
const WINDOW_OPEN = new Set<ConnectPhase['name']>(['popup_open', 'awaiting_number']);

/**
 * The phases a finished sign-in may still arrive in, beyond `WINDOW_OPEN`.
 *
 * An ERROR or a CANCEL does not close Meta's window, and the business can
 * recover inside it and finish. The card resets both halves of the answer on
 * every press, so a FINISH and a code held together both come from this
 * press's window — newer and stronger evidence than the earlier message, and a
 * code that lives thirty seconds. Refusing them would leave the number
 * connected (or refused) while the card still read "Meta reported …", and its
 * "Try again" would put the business through the window a second time. Meta's
 * samples also show a user-reported error posted as CANCEL, which is why
 * `cancelled` is here too; a window that was really closed brings no code, so
 * the action is never reached from it.
 */
const FINISH_AFTER = new Set<ConnectPhase['name']>(['meta_error', 'cancelled']);

/**
 * Each event applies only from the phases it can follow, so a late message —
 * a CANCEL posted after the window closed, a second `sdk_ready` — cannot move
 * the card backwards out of `finishing` or `done`.
 *
 * One deliberate exception: `sdk_ready` lifts `sdk_blocked`. The ten-second
 * timeout is a guess, not evidence — on a slow link the SDK arrives after it,
 * and `sdk_ready` is only ever dispatched once `FB.init` has run, so a card
 * that said "blocked" and then got a working SDK should carry on rather than
 * send the admin to reload.
 */
export function reduceConnectPhase(phase: ConnectPhase, event: ConnectEvent): ConnectPhase {
  switch (event.type) {
    case 'sdk_ready':
      return phase.name === 'loading_sdk' || phase.name === 'sdk_blocked'
        ? { name: 'idle', error: null, wait: false }
        : phase;
    case 'sdk_blocked':
      // The script failing outright is firmer than the timeout that came first.
      return phase.name === 'loading_sdk' ||
        (phase.name === 'sdk_blocked' && event.cause === 'error')
        ? { name: 'sdk_blocked', cause: event.cause }
        : phase;
    case 'opened':
      return { name: 'popup_open', unseen: false };
    case 'window_unseen':
      return phase.name === 'popup_open' ? { name: 'popup_open', unseen: true } : phase;
    case 'popup_blocked':
      return phase.name === 'popup_open' ? { name: 'popup_blocked' } : phase;
    case 'closed':
      return WINDOW_OPEN.has(phase.name) ? { name: 'cancelled', step: null } : phase;
    case 'cancelled':
      return WINDOW_OPEN.has(phase.name) ? { name: 'cancelled', step: event.step } : phase;
    case 'meta_error':
      return WINDOW_OPEN.has(phase.name)
        ? { name: 'meta_error', message: event.message, sessionId: event.sessionId }
        : phase;
    case 'awaiting_number':
      return phase.name === 'popup_open' ? { name: 'awaiting_number' } : phase;
    case 'no_number':
      return phase.name === 'awaiting_number' ? { name: 'no_number' } : phase;
    case 'finishing':
      return WINDOW_OPEN.has(phase.name) || FINISH_AFTER.has(phase.name)
        ? { name: 'finishing' }
        : phase;
    case 'refused':
      return phase.name === 'finishing'
        ? { name: 'idle', error: event.error, wait: event.wait }
        : phase;
    case 'unanswered':
      return phase.name === 'finishing' ? { name: 'unanswered' } : phase;
    case 'done':
      return phase.name === 'finishing' ? { name: 'done', notice: event.notice } : phase;
  }
}

/**
 * What the card is waiting on, if anything: Meta's window, or the action
 * checking Meta's answer. While it waits, closing the card would unmount the
 * listener and the refs the answer lands in — the window stays open, the
 * business finishes in it, and nobody hears — so the card's Cancel asks first,
 * and a row keeps the controls that would replace the card off.
 *
 * `answerDue` is what the phase cannot say: whether the window may still
 * answer. The card sets it when it opens the window and clears it once
 * `FB.login`'s callback has fired — or, when the callback handed over a code,
 * once that code is spent or dropped. It counts only in `FINISH_AFTER`: an
 * ERROR or a CANCEL leaves Meta's window open and a finish plus a code still
 * moves the card to `finishing`, so until the callback says the window is gone
 * the card is still waiting on it — and after, it is not, so a window that
 * really closed does not keep a row's controls off.
 */
export function connectWaitingOn(
  phase: ConnectPhase,
  answerDue: boolean,
): 'window' | 'verifying' | null {
  if (WINDOW_OPEN.has(phase.name)) return 'window';
  if (FINISH_AFTER.has(phase.name) && answerDue) return 'window';
  if (phase.name === 'finishing') return 'verifying';
  return null;
}

/**
 * `FB.login`'s second argument.
 *
 * `response_type: 'code'` with `override_default_response_type` is what makes
 * the SDK hand back a code the server exchanges for a *business* token, rather
 * than a user token the browser would hold; the server's exchange is the only
 * thing the thirty-second code is for.
 */
export function embeddedSignupLoginOptions(configId: string) {
  return {
    config_id: configId,
    response_type: 'code',
    override_default_response_type: true,
    extras: EMBEDDED_SIGNUP_EXTRAS,
  } as const;
}

/**
 * Whether a `message` event came from Meta.
 *
 * The hostname is parsed out of the origin and compared as a hostname: a bare
 * `endsWith('facebook.com')` on the origin string passes `evilfacebook.com`,
 * and a prefix test passes `facebook.com.evil.test`. A listener that acts on
 * those would let any page the admin has open pretend to be Meta's window and
 * name a WABA — the server would refuse the ids, but the card would say Meta
 * had answered.
 */
export function isFacebookOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return hostname === 'facebook.com' || hostname.endsWith('.facebook.com');
}

export type SignupMessage =
  | {
      kind: 'finished';
      wabaId: string;
      /** Absent in the coexistence guide's own sample; the server reads it off the WABA then. */
      phoneNumberId: string | null;
      businessId: string | null;
    }
  | { kind: 'cancelled'; step: string | null }
  | { kind: 'error'; message: string | null; code: string | null; sessionId: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * Reads one `message` event's data as an Embedded Signup event, or null for
 * anything else — another SDK's message, a message from Meta that is not about
 * signup, or garbage.
 *
 * Takes the raw `event.data`, which Meta sends as a JSON string, and tolerates
 * an object as well. Never throws: this runs inside a window listener that
 * receives every message any script on the page posts, and a listener that
 * throws on one of them stops hearing the one it was waiting for.
 */
export function parseSignupMessage(data: unknown): SignupMessage | null {
  let message: unknown = data;
  if (typeof data === 'string') {
    try {
      message = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!isRecord(message) || message.type !== SIGNUP_MESSAGE_TYPE) return null;

  const payload = isRecord(message.data) ? message.data : {};

  switch (message.event) {
    case SIGNUP_EVENTS.finished:
    case SIGNUP_EVENTS.finishedStandard: {
      const wabaId = text(payload.waba_id);
      if (!wabaId) return null;
      return {
        kind: 'finished',
        wabaId,
        phoneNumberId: text(payload.phone_number_id),
        businessId: text(payload.business_id),
      };
    }
    case SIGNUP_EVENTS.cancelled:
      return { kind: 'cancelled', step: text(payload.current_step) };
    case SIGNUP_EVENTS.error:
      return {
        kind: 'error',
        message: text(payload.error_message),
        // Spelled `error_id` on one page and `error_code` on the other.
        code: text(payload.error_code) ?? text(payload.error_id),
        sessionId: text(payload.session_id),
      };
    default:
      return null;
  }
}

/**
 * The step a cancelled window was on, in words.
 *
 * `PHONE_NUMBER_SETUP` is the one Meta's sample shows; the others are steps
 * whose names describe themselves, so a label cannot say something the name
 * does not. Anything else is printed as Meta spelled it rather than guessed at.
 */
const STEP_LABELS: Record<string, string> = {
  PHONE_NUMBER_SETUP: 'choosing the number',
  PHONE_NUMBER_VERIFICATION: 'verifying the number',
  BUSINESS_ACCOUNT_SELECTION: 'choosing the business portfolio',
  WABA_SELECTION: 'choosing the WhatsApp business account',
};

export function signupStepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
}
