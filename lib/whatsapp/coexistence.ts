import { formatDateTime } from '@/lib/format';

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
 * offboarded and complete the flow again." Measured from `onboardedAt`, which
 * is the moment the sign-in code was exchanged — the attempt row's
 * `created_at`, which a retry does not move. Meta's own clock starts a few
 * seconds before that, inside its window, so the window here closes a few
 * seconds late: a request in those seconds is refused by Meta (2593108) and
 * says so, which is the cheaper side to be wrong on than refusing the one
 * request a business gets.
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
  /**
   * The attempt that wrote this object. A re-run of the same attempt finds its
   * own connection here and leaves it be; a different attempt finding one is a
   * reconnect.
   */
  onboardingId: string | null;
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
    onboardingId: text(raw.onboardingId),
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

/**
 * How many phases Meta copies the history in. Each `history` webhook names its
 * phase (0, 1, 2) and that phase's progress, and the phases finish in no
 * particular order — so "done" is every one of them at 100, not the last one.
 */
export const HISTORY_PHASES = 3;

/** What the console can say about the copy of the chat history. */
export type HistoryProgress = {
  /** A request went out and Meta accepted it. */
  requested: boolean;
  /** Meta refused the request itself (the slot holds an error). */
  refused: string | null;
  declined: boolean;
  chunks: number;
  /** Phases at 100, out of `HISTORY_PHASES`. */
  phasesDone: number;
  /** The least-finished phase's progress, which is what is still to come. */
  percent: number;
  done: boolean;
};

export function historyProgress(coexistence: Coexistence): HistoryProgress {
  const slot = coexistence.syncs.history;
  const requested = Boolean(slot && 'requestId' in slot && slot.requestId);
  const refused = slot && 'error' in slot && !requested ? slot.error : null;
  const declined = Boolean(slot?.declined);
  const chunks = slot?.chunks ?? 0;

  const byPhase = slot?.progressByPhase ?? {};
  const phases = Array.from({ length: HISTORY_PHASES }, (_, phase) => byPhase[String(phase)] ?? 0);
  const phasesDone = phases.filter((progress) => progress >= 100).length;
  const percent = Math.min(...phases);

  return {
    requested,
    refused,
    declined,
    chunks,
    phasesDone,
    percent,
    done: declined || (requested && phasesDone === HISTORY_PHASES),
  };
}

/**
 * Whether there is nothing more to wait for from the phone's chat history:
 * every phase arrived, or the business declined to share it. A copy that was
 * never requested, or that Meta refused, is not done — it is not started, and
 * the "copy again" button is what that case is for.
 */
export function historyDone(coexistence: Coexistence): boolean {
  return historyProgress(coexistence).done;
}

/**
 * How long a copy in progress is waited on before the page stops asking.
 *
 * Six months of chats can take hours, but not days: a copy that has moved
 * nothing for a day is a phone that was closed, and a page polling for it
 * every fifteen seconds for ever is a tab nobody will notice is still asking.
 * The same length as the copy window, because that is the only duration Meta
 * states about the process.
 */
export const SYNC_STALE_MS = SYNC_WINDOW_MS;

/** When a sync last did anything: the latest chunk, else the request itself. */
function lastMovedAt(slot: SyncRequested & { lastReceivedAt?: string }): number {
  return Math.max(
    Date.parse(slot.requestedAt) || 0,
    slot.lastReceivedAt ? Date.parse(slot.lastReceivedAt) || 0 : 0,
  );
}

/**
 * Whether the phone is still expected to send more: the history was requested,
 * is not done, and has moved inside the last day. What the progress card and
 * the channel row poll on.
 */
export function isSyncing(coexistence: Coexistence, now: Date): boolean {
  const slot = coexistence.syncs.history;
  if (!slot || !('requestId' in slot) || !slot.requestId) return false;
  if (historyDone(coexistence)) return false;
  return now.getTime() - lastMovedAt(slot) <= SYNC_STALE_MS;
}

export type CoexistenceBadge = {
  label: string;
  tone: 'brand' | 'neutral' | 'pending' | 'success' | 'warning' | 'danger';
  /** The sentence behind the ⓘ: what the badge means and what, if anything, to do. */
  explain: string;
};

/**
 * The badges a connected channel earns, in the order the row shows them: what
 * it is, then what is still happening or went wrong with it.
 *
 * Every label is short enough for a table row and every `explain` says what to
 * do, because the row has no other way to: a badge reading "copy window
 * closed" with nothing behind it is a mystery, and one reading "copy window
 * closed — reconnect to open another" is a sentence long enough to break the
 * row. The pure half of the admin page; `CoexistenceBadges` draws these.
 */
export function coexistenceBadges(coexistence: Coexistence, now: Date): CoexistenceBadge[] {
  const badges: CoexistenceBadge[] = [
    {
      label: 'WhatsApp Business app',
      tone: 'brand',
      explain:
        `Connected through Meta on ${formatDateTime(coexistence.onboardedAt)}. The number keeps ` +
        `working on the phone: replies typed there count as the team's and appear on tickets ` +
        `as "WhatsApp Business app"; console replies go out over Cloud API.`,
    },
  ];

  if (coexistence.disconnected) {
    const { event, reason, at } = coexistence.disconnected;
    badges.push({
      label: 'disconnected on the phone',
      tone: 'danger',
      explain:
        `Meta reported ${event || 'a disconnection'}${reason ? ` (${reason})` : ''} on ` +
        `${formatDateTime(at || now)}. Sends from this number fail until it is reconnected ` +
        `through Meta — press Reconnect and complete the window again.`,
    });
  }

  const history = historyProgress(coexistence);
  const historySlot = coexistence.syncs.history;
  if (history.refused) {
    badges.push({
      label: 'history failed',
      tone: 'danger',
      explain: `Meta refused the request for the chat history: ${history.refused}`,
    });
  } else if (history.declined) {
    badges.push({
      label: 'history declined on the phone',
      tone: 'warning',
      explain:
        'The business chose not to share its chat history when the number was connected: ' +
        'the WhatsApp Business app asked on the phone and the answer was no. Turn sharing ' +
        'on there and press "Copy history again" while the 24-hour window is open.',
    });
  } else if (history.requested && history.done) {
    badges.push({
      label: 'history copied',
      tone: 'success',
      explain: `Up to six months of chats arrived from the phone in ${history.chunks} chunk${
        history.chunks === 1 ? '' : 's'
      }. Each past conversation is a resolved ticket.`,
    });
  } else if (history.requested && historySlot && 'requestId' in historySlot) {
    const stalled = now.getTime() - lastMovedAt(historySlot) > SYNC_STALE_MS;
    badges.push(
      stalled
        ? {
            label: `history stalled at ${history.percent}%`,
            tone: 'warning',
            explain:
              'Nothing has arrived from the phone for a day. The copy only runs while the ' +
              'WhatsApp Business app is open on the phone; open it and the copy resumes. ' +
              'If it was open all along, reconnecting the number opens a new copy window.',
          }
        : {
            label:
              history.chunks === 0
                ? 'copying history · waiting for the phone'
                : `copying history ${history.phasesDone}/${HISTORY_PHASES} · ${history.percent}%`,
            tone: 'pending',
            explain:
              'The phone is sending up to six months of chats, in three phases that finish in ' +
              'no particular order. Keep the WhatsApp Business app open on the phone until ' +
              'every phase reaches 100% — it can take hours.',
          },
    );
  }

  // A slot holds a request id or an error, never both: a success clears the
  // error and a refusal never overwrites a request (`recordSyncRequest`).
  const contacts = coexistence.syncs.contacts;
  if (contacts && 'requestId' in contacts && contacts.requestId) {
    const received = contacts.received ?? 0;
    badges.push(
      received > 0
        ? {
            label: `${received} contact${received === 1 ? '' : 's'}`,
            tone: 'neutral',
            explain:
              `${received} contact${received === 1 ? '' : 's'} arrived from the phone's address ` +
              `book, named as the business saved them.`,
          }
        : {
            label: 'waiting for contacts',
            tone: 'pending',
            explain:
              "The phone's contacts were requested and none has arrived yet. They arrive " +
              'while the WhatsApp Business app is open on the phone.',
          },
    );
  } else if (contacts && 'error' in contacts) {
    badges.push({
      label: 'contacts failed',
      tone: 'danger',
      explain: `Meta refused the request for the phone's contacts: ${contacts.error}`,
    });
  }

  const neverCopied = SYNC_TYPES.filter((type) => {
    const permission = canRequestSync(coexistence, type, now);
    return !permission.ok && permission.reason === 'window_closed';
  });
  if (neverCopied.length > 0) {
    badges.push({
      label: 'copy window closed',
      tone: 'warning',
      explain:
        `The 24 hours after connecting have passed and the ${neverCopied
          .map((type) => (type === 'contacts' ? 'contacts' : 'chat history'))
          .join(' and ')} ${neverCopied.length === 1 ? 'was' : 'were'} never copied. ` +
        `Reconnecting the number through Meta opens a new window.`,
    });
  }

  return badges;
}
