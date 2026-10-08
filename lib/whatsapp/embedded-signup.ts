/**
 * The browser half of connecting a WhatsApp Business-app number: what Meta's
 * JavaScript SDK is asked for, and what its window says back.
 *
 * Pure and client-safe, and deliberately small. Everything the popup returns
 * is a *claim* — the server proves the code by exchanging it and the ids by
 * reading them with the token (`./onboarding`) — so this module only has to
 * get three things right: open the window with the options Meta documents,
 * take a message from Meta's own origin and nobody else's, and read the three
 * events the window sends without ever throwing in a `message` listener.
 *
 * Verified against Meta's Embedded Signup and coexistence pages on 2026-10-08.
 * Where the pages disagree (there are two generations of them), the constants
 * below say which one they follow, and the test beside this file pins them.
 */

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
 * read as a popup the browser blocked. A very fast cancel reads the same way,
 * and the recovery is the same either way: press the button again.
 */
export const POPUP_BLOCKED_MS = 1_000;

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
