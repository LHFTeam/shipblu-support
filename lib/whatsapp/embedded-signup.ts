/**
 * The browser half of connecting a WhatsApp Business-app number: what Meta's
 * JavaScript SDK is asked for, and what its window says back.
 *
 * Pure and client-safe. Everything the popup returns is a *claim* — the server
 * proves the code by exchanging it and the ids by reading them with the token
 * (`./onboarding`) — so this module only has to get three things right: open
 * the window with the options Meta documents, take a message from Meta's own
 * origin and nobody else's, and read the events the window sends without ever
 * throwing in a `message` listener.
 *
 * It also holds the connect card's phase machine and the two pieces of SDK
 * plumbing the card leans on — seeing whether the browser refused the window,
 * and sharing the SDK's one `fbAsyncInit` between cards. They are here rather
 * than in the card because each is a rule with a way to be wrong that only
 * shows in a browser, and the card is a `'use client'` file a node test cannot
 * import; here, the test beside this file runs them.
 *
 * Verified for Embedded Signup v4 against Meta's versions, v4, implementation,
 * coexistence and errors pages on 2026-10-09. Where the pages disagree — and
 * the v4 pages disagree with each other about the launch — the constants below
 * say which one they follow and what is still open, and the test beside this
 * file pins them.
 */

import { GRAPH_VERSION } from '@/lib/meta/graph';

/** Loaded once per document, when the connect card opens — never on the click. */
export const FB_SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';

/** The `type` every Embedded Signup `postMessage` carries. */
export const SIGNUP_MESSAGE_TYPE = 'WA_EMBEDDED_SIGNUP';

/**
 * The events the window posts, by what they mean here: v4's finish types as
 * the implementation page lists them, less the two flows nothing here starts.
 *
 * `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` is the Business-app flow's finish
 * and `FINISH` the Cloud API flow's. Both are read as "finished": v4 asks for
 * the number first (Meta is still rolling that order out) and enters the
 * coexistence flow by itself when the number is already on the Business app,
 * so which flow ran is decided by the number the business typed, not by the
 * browser — and the server treats the ids either way as claims it proves; a
 * number that turns out not to be on the Business app is recorded as such by
 * the job's `number` step.
 *
 * `FINISH_ONLY_WABA` — "completed flow without a phone number" — is its own
 * kind and never "finished". The server reads the number off the WABA when the
 * window names none, which is right for a converted Business-app account,
 * whose only number is the one converted, and wrong here: an existing WABA the
 * business picked without adding a number would have the code spent on it and,
 * if it already holds exactly one number, that number connected — one nobody
 * chose in the window.
 *
 * `CANCEL` is a closed window or a user-reported error — Meta posts the second
 * as CANCEL too (`parseSignupMessage` tells them apart). `ERROR` is still in
 * v4's list, with no sample of what it carries, so it is read with the fields
 * of the reported error and nothing assumed beyond them.
 *
 * Not read: `FINISH_OBO_MIGRATION` and `FINISH_GRANT_ONLY_API_ACCESS`, the
 * on-behalf-of migration and grant-only flows, which this launch does not ask
 * for. One arriving anyway reaches the card as a code with no finish, and the
 * card's wait ends that as "no number" (`FINISH_WAIT_MS`) — it connects nothing.
 */
export const SIGNUP_EVENTS = {
  finished: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  finishedStandard: 'FINISH',
  finishedWithoutNumber: 'FINISH_ONLY_WABA',
  cancelled: 'CANCEL',
  error: 'ERROR',
} as const;

/**
 * The `extras` handed to `FB.login` for Embedded Signup v4, with the
 * WhatsApp Business app onboarding switched on.
 *
 * **The version is not chosen here.** v4 is a property of the Facebook Login
 * for Business configuration `META_EMBEDDED_SIGNUP_CONFIG_ID` names: one created
 * with the "WhatsApp Embedded Signup" login variation and products selected —
 * Cloud API at least — and "selecting the products will automatically set you
 * to v4". Meta's pages say to create a new configuration for it, and none says
 * whether adding products to an old one does the same. The Business-app
 * onboarding is not among those products: v4 "continues to support" it
 * through `featureType`, below. A configuration with no products is not v4
 * whatever these extras say, and v2 and v3, with their public previews, end on
 * 2026-10-15; Meta does not say whether a launch on one after that is refused,
 * upgraded or broken. Nothing in the repo can read which version a
 * configuration is — `coexistenceReadiness` checks that the variable is set,
 * no more — so the id is the App Dashboard's to get right.
 *
 * Two keys are gone from the shape before this one, and must not come back:
 * - `sessionInfoVersion: '3'`. A v2 setting: v3 and v4 send the session info
 *   for every flow. `featureType` plus `sessionInfoVersion` with no `version`
 *   is v2's own signature, and no page says whether a v4 configuration ignores
 *   that or falls back on it. The coexistence guide's Step 2 still shows it
 *   beside `featureType` because that sample is the v2 shape — which this
 *   comment used to call v3; v3 needed `version: 'v3'`.
 * - `version`. Its documented values are the public previews, `v3` and `v2`;
 *   there is no `v4`, which comes from the configuration.
 *
 * Still open, because Meta's v4 pages disagree with each other: the versions
 * page gives v4 `extras: {}` ("purposely empty"), the implementation page
 * `{ setup: {} }`, and the v4 page sends Business-app onboarding to the
 * coexistence guide's `featureType` step. No page shows the three together;
 * this is their union, and `setup` is empty, so it pre-fills nothing.
 * `featureType` stays because the v4 public preview's page says a number
 * already on the Business app enters the coexistence flow by itself, while v4's
 * own flow page says so only "if you have enabled Coexistence" — linking to
 * this switch. **Re-check against the Embedded Signup Builder** (App
 * Dashboard → WhatsApp → Embedded Signup Builder), which writes the snippet for
 * the app's own configuration; this is one constant so adopting its shape is
 * one edit.
 */
export const EMBEDDED_SIGNUP_EXTRAS = {
  setup: {},
  featureType: 'whatsapp_business_app_onboarding',
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
 * thing the thirty-second code is for. v4 leaves these three as they were, and
 * the exchange too; no option here picks the version (`EMBEDDED_SIGNUP_EXTRAS`
 * says what does).
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
  /** `FINISH_ONLY_WABA`: finished with no number — `SIGNUP_EVENTS` says why it is kept apart. */
  | { kind: 'finished_without_number' }
  | { kind: 'cancelled'; step: string | null }
  | { kind: 'error'; message: string | null; code: string | null; sessionId: string | null };

type ReportedError = Extract<SignupMessage, { kind: 'error' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/**
 * An error reference, as a string. Meta's sample quotes the `error_code`
 * placeholder but gives the example value, 524126, as bare digits, so a number
 * is taken too: dropping it would lose the detail a support case is looked up
 * by.
 */
const reference = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);

/**
 * The error a window message reports, or null when it reports none.
 *
 * `error_code` is the spelling every current page uses; `error_id` is what an
 * earlier copy of Meta's page had, and is read only when `error_code` is
 * absent, which costs nothing.
 */
function reportedError(payload: Record<string, unknown>): ReportedError | null {
  const message = text(payload.error_message);
  const code = reference(payload.error_code) ?? reference(payload.error_id);
  const sessionId = text(payload.session_id);
  return message || code || sessionId ? { kind: 'error', message, code, sessionId } : null;
}

/**
 * Reads one `message` event's data as an Embedded Signup event, or null for
 * anything else — another SDK's message, a message from Meta that is not about
 * signup, or garbage.
 *
 * Takes the raw `event.data`, which Meta sends as a JSON string, and tolerates
 * an object as well. Never throws: this runs inside a window listener that
 * receives every message any script on the page posts, and a listener that
 * throws on one of them stops hearing the one it was waiting for.
 *
 * `version` is not read. v4's own samples carry none, while the coexistence
 * and errors pages' samples still say `version: 3`, so nothing can depend on it.
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
    case SIGNUP_EVENTS.finishedWithoutNumber:
      return { kind: 'finished_without_number' };
    case SIGNUP_EVENTS.cancelled:
      // Meta posts a user-reported error as CANCEL, with the message and the
      // session id its support asks for. Read as a cancel, the card told the
      // admin they had closed the window and threw both away.
      return reportedError(payload) ?? { kind: 'cancelled', step: text(payload.current_step) };
    case SIGNUP_EVENTS.error:
      return (
        reportedError(payload) ?? { kind: 'error', message: null, code: null, sessionId: null }
      );
    default:
      return null;
  }
}

/**
 * The step a cancelled window was on, in words: the six `current_step` values
 * Meta's errors page lists, each worded from the screen it names for it.
 *
 * Anything else is printed as Meta spelled it rather than guessed at. That
 * covers the coexistence flow's own screens — the business profile, the QR
 * code, the terms — for which no value is documented, and the order a business
 * meets the rest in varies while v4's number-first screens are still rolling
 * out. `WABA_SELECTION`, guessed here before, is on no page; the WhatsApp
 * account picker is `WABA_PHONE_PROFILE_PICKER`.
 */
const STEP_LABELS: Record<string, string> = {
  BUSINESS_ACCOUNT_SELECTION: 'choosing the business portfolio',
  WABA_PHONE_PROFILE_PICKER: 'choosing the WhatsApp account',
  WHATSAPP_BUSINESS_PROFILE_SETUP: 'creating the WhatsApp account',
  PHONE_NUMBER_SETUP: 'choosing the number',
  PHONE_NUMBER_VERIFICATION: 'verifying the number',
  PERMISSIONS: 'reviewing the permissions',
};

export function signupStepLabel(step: string): string {
  // Own keys only: an index into an object literal also reaches what every
  // object inherits, so a step spelled `constructor` or `toString` would print
  // a function's source where the step belongs.
  return Object.hasOwn(STEP_LABELS, step) ? STEP_LABELS[step]! : step;
}

/**
 * What the card says when Meta's window reported an error.
 *
 * Meta's sample message is sentences of its own — "Your verified name
 * violates WhatsApp guidelines. Please edit your verified name and try
 * again." — so a full stop is added only where the message does not end one
 * already; appending it blindly printed "try again..". The session id is named
 * as what to quote, because it is the reference Meta's support asks for.
 */
export function metaErrorSentence(message: string | null, sessionId: string | null): string {
  const reported = message?.trim() || 'an error with no message';
  const ended = /[.!?؟…]$/u.test(reported) ? reported : `${reported}.`;
  return (
    `Meta reported: ${ended}` +
    (sessionId ? ` Reference ${sessionId} — quote it to Meta support.` : '')
  );
}
