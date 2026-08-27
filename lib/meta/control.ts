import type { MetaPlatform } from './types';

/**
 * Who holds thread control on a Messenger or Instagram conversation, and what
 * this app can do about it.
 *
 * Meta calls this Conversation Routing now; the endpoints are the Handover
 * Protocol's, kept for backwards compatibility. One app at a time is the
 * *thread owner* and only that app may send. Everyone else is subscribed, sees
 * the traffic in the webhook's `standby` array, and is refused by the Send API
 * — which is the state `lib/meta/thread.ts` already explains to the agent.
 *
 * This module is the other half: not "can we answer" but "who has it, and can
 * we take it". Pure, so the decision is testable without Graph — the I/O lives
 * in `lib/meta/client.ts`.
 */

/**
 * The inboxes Meta operates itself, which are ordinary apps as far as thread
 * control is concerned.
 *
 * Hard-coded because they are Meta's own fixed ids, published in the
 * Conversation Routing documentation as the values to pass as `target_app_id`.
 * Named here so a reading of `263902037430900` renders as "the Page inbox"
 * rather than as an opaque number the agent has no way to interpret.
 */
export const PAGE_INBOX_APP_ID = '263902037430900';
export const INSTAGRAM_INBOX_APP_ID = '1217981644879628';

export function describeAppId(appId: string | null): string {
  if (!appId) return 'no app';
  if (appId === PAGE_INBOX_APP_ID) return 'the Facebook Page inbox';
  if (appId === INSTAGRAM_INBOX_APP_ID) return 'the Instagram inbox';
  return `app ${appId}`;
}

/**
 * What `GET /{account-id}/thread_owner` told us.
 *
 * Three shapes, and the difference between them matters more than it looks.
 * Meta returns the owning `app_id` only when the caller is the owner *or* the
 * page's default app. Any other caller gets an `expiration` with no id when the
 * thread is owned, and an empty payload when it is idle. So a null `appId` is
 * not "nobody owns this" — combined with `expiresAt` it means "somebody does,
 * and Graph will not say who".
 */
export type ThreadOwnerReading = {
  appId: string | null;
  /** When the current owner's control lapses back to idle, if Graph said. */
  expiresAt: Date | null;
};

/**
 * Reads the `thread_owner` payload, tolerating every shape Graph sends.
 *
 * `app_id` comes back as a JSON number in the documented example and as a
 * string in practice, so it is normalised to a string here — comparing a number
 * against `META_APP_ID` would silently never match and the button would offer
 * to take a thread this app already owns.
 */
export function parseThreadOwner(payload: unknown): ThreadOwnerReading {
  const data = (payload as { data?: unknown })?.data;
  const first = Array.isArray(data) ? data[0] : null;
  const owner = (first as { thread_owner?: unknown })?.thread_owner as
    { app_id?: unknown; expiration?: unknown } | undefined;

  const rawId = owner?.app_id;
  const appId =
    typeof rawId === 'string' && rawId ? rawId : typeof rawId === 'number' ? String(rawId) : null;

  const expiration = owner?.expiration;
  const expiresAt = toInstant(expiration);

  return { appId, expiresAt };
}

/**
 * Meta's timestamps arrive as seconds here and as milliseconds elsewhere in the
 * same product, with no field naming the unit. Anything below this threshold is
 * seconds — it is the year 2001 in milliseconds, and thread control expires
 * within seven days of now.
 */
const MILLISECOND_FLOOR = 1_000_000_000_000;

function toInstant(value: unknown): Date | null {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const date = new Date(seconds < MILLISECOND_FLOOR ? seconds * 1000 : seconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type ControlHolder =
  /** This app is the thread owner and may send. */
  | 'us'
  /** Another app owns it — named in `ownerAppId` when Graph would say. */
  | 'other'
  /** Nobody owns it. Only the page's default app may send into an idle thread. */
  | 'idle'
  /** No reading, or nothing to read it against. */
  | 'unknown';

export type MetaControlState = {
  holder: ControlHolder;
  /** The owning app, when Graph named one. Null whenever it would not. */
  ownerAppId: string | null;
  expiresAt: Date | null;
  /** What the button will do. Null when there is nothing sensible to offer. */
  intent: 'take' | 'release' | null;
  /** The button's label. */
  label: string;
  /** One sentence for the agent, saying what pressing it does. */
  explanation: string;
  /** Why no action is offered, when `intent` is null. */
  blockedReason: string | null;
};

export type MetaControlInput = {
  platform: MetaPlatform;
  /** `META_APP_ID` — this deployment's own Meta app. */
  ourAppId: string | null;
  /** The live `thread_owner` reading, or null when we could not get one. */
  reading: ThreadOwnerReading | null;
  /**
   * The customer's last message arrived in the `standby` array, so at that
   * moment another app held the thread. The fallback when there is no reading,
   * and never more than a fallback: it describes when the message arrived, not
   * now.
   */
  standby: boolean;
};

/**
 * What the control button should say, and what it should do.
 *
 * Deliberately always offers *something* when we know our own app id. An agent
 * looking at a ticket they cannot answer needs a way out of it, and the two
 * uninformative Graph responses — an expiration with no id, an empty payload —
 * are exactly the cases where a cautious "we cannot tell" button would strand
 * them. Taking an idle thread is explicitly allowed, and taking an owned one is
 * refused by Graph rather than by us, with a message worth showing.
 */
export function metaControlState(input: MetaControlInput): MetaControlState {
  const product = input.platform === 'instagram' ? 'Instagram' : 'Messenger';

  if (!input.ourAppId) {
    return {
      holder: 'unknown',
      ownerAppId: null,
      expiresAt: null,
      intent: null,
      label: 'Control unavailable',
      explanation: '',
      blockedReason:
        'META_APP_ID is not set, so this deployment cannot tell whether it holds thread ' +
        'control — the answer is a comparison against our own app id.',
    };
  }

  const reading = input.reading;

  // No reading at all: the read failed, or was never attempted. The standby
  // flag is the only thing left, and it is a record of the past rather than a
  // statement about now — so the holder stays 'unknown' and only the offered
  // action is guessed from it.
  if (!reading) {
    return input.standby
      ? {
          holder: 'unknown',
          ownerAppId: null,
          expiresAt: null,
          intent: 'take',
          label: 'Transfer control to this app',
          explanation:
            `The customer's last message arrived in the handover protocol's standby ` +
            `channel, so another app held this ${product} thread at least until then. ` +
            `Taking control makes this app the thread owner and lets you reply here.`,
          blockedReason: null,
        }
      : {
          holder: 'unknown',
          ownerAppId: null,
          expiresAt: null,
          intent: 'release',
          label: 'Release control',
          explanation:
            `Nothing says another app holds this ${product} thread. Releasing returns it ` +
            `to idle, where the page's default app answers.`,
          blockedReason: null,
        };
  }

  if (reading.appId && reading.appId === input.ourAppId) {
    return {
      holder: 'us',
      ownerAppId: reading.appId,
      expiresAt: reading.expiresAt,
      intent: 'release',
      label: 'Release control',
      explanation:
        `This app is the thread owner, so replies sent from here reach the customer. ` +
        `Releasing hands the ${product} conversation back: it returns to idle, and the ` +
        `page's default app answers from then on.`,
      blockedReason: null,
    };
  }

  if (reading.appId) {
    return {
      holder: 'other',
      ownerAppId: reading.appId,
      expiresAt: reading.expiresAt,
      intent: 'take',
      label: 'Transfer control to this app',
      explanation:
        `${capitalise(describeAppId(reading.appId))} holds this ${product} thread, so ` +
        `${product} refuses a reply sent from here. Taking control makes this app the ` +
        `thread owner.`,
      blockedReason: null,
    };
  }

  // An expiration with no app id. Graph names the owner only to the owner and
  // to the page's default app, so this is "somebody holds it and it is not us"
  // — the reading is uninformative precisely *because* we are neither.
  if (reading.expiresAt) {
    return {
      holder: 'other',
      ownerAppId: null,
      expiresAt: reading.expiresAt,
      intent: 'take',
      label: 'Transfer control to this app',
      explanation:
        `Another app holds this ${product} thread. ${product} names the owner only to the ` +
        `owner itself and to the page's default app, so it will not say which — but it ` +
        `answered that the thread is owned, and this app is not the owner. Taking control ` +
        `makes it one.`,
      blockedReason: null,
    };
  }

  // Empty payload: the thread is idle. Meta's own words — an idle thread is one
  // with no customer message in the last 24 hours, or one whose owner released
  // it — and only the default app may send into it.
  return {
    holder: 'idle',
    ownerAppId: null,
    expiresAt: null,
    intent: 'take',
    label: 'Transfer control to this app',
    explanation:
      `No app holds this ${product} thread — it is idle, which means only the page's ` +
      `default app may send. Taking control makes this app the thread owner so a reply ` +
      `from here is accepted.`,
    blockedReason: null,
  };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Whether a control reading is newer than the last thing the customer sent.
 *
 * The two disagree by design. `standby` is stamped on an inbound message and is
 * true of the instant it arrived; a control reading is true of the instant it
 * was taken. Whichever is newer wins, and nothing else does — a take that
 * happened before the customer's latest message was, by then, already undone by
 * whatever put that message in standby.
 */
export function controlReadingWins(
  checkedAt: Date | null | undefined,
  lastInboundAt: Date | null | undefined,
): boolean {
  if (!checkedAt) return false;
  if (!lastInboundAt) return true;
  return checkedAt.getTime() >= lastInboundAt.getTime();
}

/**
 * Whether another app holds this thread *now*, for the send-side verdict in
 * `lib/meta/thread.ts`.
 *
 * Two sources disagree and neither is wrong. A control snapshot is true of the
 * moment it was taken; the inbound `standby` flag is true of the moment that
 * message arrived. The newer one wins — see `controlReadingWins` — and with no
 * snapshot at all this is exactly the flag, which is what every ticket written
 * before this column existed depends on.
 *
 * An idle thread reads as *not* blocked, which is the one case worth spelling
 * out. Meta says only the page's default app may send into an idle thread, and
 * gives us no way to ask whether we are that app: `thread_owner` returns an
 * empty payload either way. This deployment has been sending on Messenger
 * throughout, so treating idle as blocked would refuse replies that work today
 * on the strength of a guess. Graph's own refusal, if one comes, says more than
 * a guess would — and the control button offers taking the thread as the fix.
 */
export function anotherAppHoldsThread(input: {
  ourAppId: string | null;
  control: { appId: string | null; checkedAt: Date | null } | null;
  lastInboundStandby: boolean;
  lastInboundAt: Date | null;
}): boolean {
  const control = input.control;

  if (control && controlReadingWins(control.checkedAt, input.lastInboundAt)) {
    if (!control.appId) return false;
    return control.appId !== input.ourAppId;
  }

  return input.lastInboundStandby;
}
