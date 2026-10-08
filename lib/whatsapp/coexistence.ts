/**
 * What a WhatsApp channel connected through Meta's coexistence onboarding
 * remembers about it — the `coexistence` object in `channels.config`.
 *
 * Coexistence is a number that stays live on the WhatsApp Business *app* on a
 * phone while it is connected to Cloud API: the business keeps typing replies on
 * the phone, the helpdesk answers on the same number, and Meta mirrors each side
 * to the other. Connecting one also opens a once-only window to copy the phone's
 * contacts and up to six months of its chats (`plans/whatsapp-coexistence.md`).
 *
 * Pure and client-safe, so the admin page can draw the same badges the job
 * decides from. Written only by `lib/whatsapp/coexistence-state.ts`, one
 * `jsonb_set` at a time, because the history webhooks that update it arrive
 * concurrently.
 */

/** The two things Meta's SMB App Data API can be asked to copy. */
export const SYNC_TYPES = ['contacts', 'history'] as const;
export type SyncType = (typeof SYNC_TYPES)[number];

/** Meta's `sync_type` for each. */
export const META_SYNC_TYPE: Record<SyncType, 'smb_app_state_sync' | 'history'> = {
  contacts: 'smb_app_state_sync',
  history: 'history',
};

/**
 * How long after onboarding the copy may be asked for.
 *
 * Meta's words: "After you onboard the business customer, you have 24 hours to
 * synchronize their contacts and messaging history, otherwise they must be
 * offboarded and complete the flow again." Measured from `onboardedAt`, which the
 * job writes when it finishes the channel step — later than the moment Meta
 * counts from, so this errs towards refusing a request Meta might still have
 * taken, never towards sending one it will refuse.
 */
export const SYNC_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A request that went out and was accepted. */
export type SyncRequested = {
  requestId: string;
  requestedAt: string;
};

/** A request Meta refused, kept in the same slot so a retry can replace it. */
export type SyncRefused = {
  error: string;
  attemptedAt: string;
};

export type ContactsSync = (SyncRequested | SyncRefused) & {
  received?: number;
  lastReceivedAt?: string;
};

export type HistorySync = (SyncRequested | SyncRefused) & {
  chunks?: number;
  /** Meta reports history in phases; each phase's progress, 0–100. */
  progressByPhase?: Record<string, number>;
  /** The business turned history sharing off on the phone (Meta's 2593109). */
  declined?: { at: string; code: number };
};

export type Coexistence = {
  onboardedAt: string;
  wabaId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  subscribedAt: string | null;
  syncs: { contacts?: ContactsSync; history?: HistorySync };
  /** Meta told us the number was disconnected from the phone (`account_update`). */
  disconnected?: { at: string; event: string; reason: string | null };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The `coexistence` object out of a channel's config, or null for a channel
 * that was not connected this way.
 *
 * Tolerant of shape, because the column is jsonb and an admin, a migration or a
 * future version of this module may have written it: a field of the wrong type
 * reads as absent rather than throwing on a page that only wanted a badge.
 */
export function parseCoexistence(config: unknown): Coexistence | null {
  if (!isRecord(config) || !isRecord(config.coexistence)) return null;
  const raw = config.coexistence;

  const onboardedAt = text(raw.onboardedAt);
  const wabaId = text(raw.wabaId);
  if (!onboardedAt || !wabaId) return null;

  const syncs = isRecord(raw.syncs) ? raw.syncs : {};

  return {
    onboardedAt,
    wabaId,
    displayPhoneNumber: text(raw.displayPhoneNumber),
    verifiedName: text(raw.verifiedName),
    subscribedAt: text(raw.subscribedAt),
    syncs: {
      ...(isRecord(syncs.contacts) ? { contacts: syncs.contacts as ContactsSync } : {}),
      ...(isRecord(syncs.history) ? { history: syncs.history as HistorySync } : {}),
    },
    ...(isRecord(raw.disconnected)
      ? {
          disconnected: {
            at: text(raw.disconnected.at) ?? '',
            event: text(raw.disconnected.event) ?? '',
            reason: text(raw.disconnected.reason),
          },
        }
      : {}),
  };
}

export type SyncPermission =
  { ok: true } | { ok: false; reason: 'already_requested' | 'window_closed'; sentence: string };

/**
 * Whether the contacts or the history may be asked for now.
 *
 * Once per onboarding — Meta: "You can only perform this step once. If you need
 * to perform it again, the customer must first offboard, then complete the
 * Embedded Signup flow again" — and only inside the window. A request Meta
 * refused left no `requestId`, so it may be tried again while the window is
 * open; that is the case the "Copy again" button exists for.
 */
export function canRequestSync(
  coexistence: Coexistence,
  type: SyncType,
  now: Date,
): SyncPermission {
  const slot = coexistence.syncs[type];
  const label = type === 'contacts' ? 'The contacts' : 'The chat history';

  if (slot && 'requestId' in slot && slot.requestId) {
    return {
      ok: false,
      reason: 'already_requested',
      sentence:
        `${label} for this number were already requested from the phone, and Meta allows ` +
        `that once per connection. Asking again needs the number disconnected from the ` +
        `WhatsApp Business app and connected again.`,
    };
  }

  const onboarded = Date.parse(coexistence.onboardedAt);
  if (!Number.isFinite(onboarded) || now.getTime() - onboarded > SYNC_WINDOW_MS) {
    return {
      ok: false,
      reason: 'window_closed',
      sentence:
        `${label} can only be copied in the 24 hours after the number is connected, and ` +
        `that window has closed. Reconnecting the number opens a new one.`,
    };
  }

  return { ok: true };
}
