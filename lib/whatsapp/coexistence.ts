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
 * decides from. Created by the onboarding job and written after that only by
 * `lib/whatsapp/coexistence-state.ts`, one `jsonb_set` at a time, because the
 * history webhooks that update it arrive concurrently — an admin's save of the
 * channel leaves it to the database too (`whatsappEditColumns`).
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
  /**
   * The highest `progress` each phase's chunks have reported, 0–100. Meta's
   * `progress` is the whole copy's percentage, not the phase's, so the highest
   * value across phases is how far the copy has got (`historyProgress`). Kept
   * per phase because that is the shape already stored, and the per-phase
   * high-water marks still yield the overall one.
   */
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
  /**
   * Meta told us the number was disconnected from the phone (`account_update`).
   * `initiatedBy` is Meta's `initiated_by` verbatim — `USER` or `SYSTEM` where
   * it says, null where it does not (only a `PARTNER_REMOVED` carries one).
   */
  disconnected?: { at: string; event: string; reason: string | null; initiatedBy: string | null };
  /**
   * When the newest `account_update` applied to this connection happened —
   * the high-water mark that keeps an older event processed late from undoing
   * a newer one (`applyWhatsAppAccountUpdate`). Not `disconnected.at`, which
   * `ACCOUNT_RECONNECTED` deletes. Only that UPDATE's SQL compares it today; a
   * reconnect writes the object afresh without it.
   */
  accountEventAt?: string;
  /**
   * Meta said, when this connection was made, that the number is not on the
   * WhatsApp Business app (`is_on_biz_app: false`). There is no phone to copy
   * from, so nothing may be asked for and a closed window is nothing missed.
   * Kept here rather than only on the attempt's step records, because the row's
   * badges and buttons read this object and nothing else.
   */
  notOnBusinessApp?: true;
  /**
   * What an earlier connection of this number finished copying, carried over
   * on a reconnect that did not ask for it again (`copiedSoFar`). Without it,
   * the fresh `syncs: {}` a reconnect writes reads as "never copied": the row
   * would badge a closed window and offer Reconnect for ever, and the next
   * reconnect would ask the phone for six months of chats the helpdesk already
   * holds. A copy that was only asked for — stalled, or never delivered — is
   * never in it, and nor is history the phone declined: the reconnect is how
   * those are asked for again.
   */
  carriedOver?: SyncType[];
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
  const carried = Array.isArray(raw.carriedOver) ? (raw.carriedOver as unknown[]) : [];
  const carriedOver = SYNC_TYPES.filter((type) => carried.includes(type));
  const accountEventAt = text(raw.accountEventAt);

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
            initiatedBy: text(raw.disconnected.initiatedBy),
          },
        }
      : {}),
    ...(accountEventAt ? { accountEventAt } : {}),
    // Only a literal `true`: a hand-written "false" string must not stop a copy.
    ...(raw.notOnBusinessApp === true ? { notOnBusinessApp: true as const } : {}),
    ...(carriedOver.length > 0 ? { carriedOver } : {}),
  };
}

export type SyncPermission =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_on_business_app' | 'already_requested' | 'window_closed';
      sentence: string;
    };

/**
 * Whether the contacts or the history may be asked for now.
 *
 * Never for a number Meta said is not on the WhatsApp Business app: there is
 * no phone to answer, and Meta refuses the request, which would land on the
 * row as a red "failed" badge for a copy that could never have happened.
 *
 * Otherwise once per onboarding — Meta: "You can only perform this step once.
 * If you need to perform it again, the customer must first offboard, then
 * complete the Embedded Signup flow again" — and only inside the window. A
 * request Meta refused left no `requestId`, so it may be tried again while the
 * window is open; that is the case the "Copy again" button exists for. What an
 * earlier connection copied (`carriedOver`) is deliberately not refused here:
 * copying it again inside the new window is a choice the row offers.
 */
export function canRequestSync(
  coexistence: Coexistence,
  type: SyncType,
  now: Date,
): SyncPermission {
  const slot = coexistence.syncs[type];
  const label = type === 'contacts' ? 'The contacts' : 'The chat history';

  if (coexistence.notOnBusinessApp) {
    return {
      ok: false,
      reason: 'not_on_business_app',
      sentence:
        `${label} cannot be copied: when this number was connected, Meta reported that it is ` +
        `not on the WhatsApp Business app, so there is no phone to copy from. If the number ` +
        `has moved onto the app since, reconnect it through Meta.`,
    };
  }

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
 * What this connection's window closed on without anything copying it: never
 * asked for, or asked and refused, and not carried over from an earlier
 * connection. Empty for a number not on the Business app — nothing was ever
 * there to copy.
 *
 * The one answer to "was something missed?", so the row's "copy window closed"
 * badge and its Reconnect button cannot disagree about it.
 */
export function uncopiedAfterWindow(coexistence: Coexistence, now: Date): SyncType[] {
  return SYNC_TYPES.filter((type) => {
    if (coexistence.carriedOver?.includes(type)) return false;
    const permission = canRequestSync(coexistence, type, now);
    return !permission.ok && permission.reason === 'window_closed';
  });
}

/** What the console can say about the copy of the chat history. */
export type HistoryProgress = {
  /** A request went out and Meta accepted it. */
  requested: boolean;
  /** Meta refused the request itself (the slot holds an error). */
  refused: string | null;
  declined: boolean;
  chunks: number;
  /** How far the whole copy has got, 0–100: the highest `progress` any chunk reported. */
  percent: number;
  done: boolean;
};

/**
 * Where the copy of the phone's chat history stands.
 *
 * Each `history` webhook names a phase (0: the last day, 1: up to 90 days, 2:
 * up to 180) and a `progress`, which Meta documents as the copy's overall
 * percentage — 100 is the copy complete — not the phase's. So the copy is
 * done when any chunk says 100, and how far it has got is the highest value
 * seen, chunks arriving in no order. Reading it per phase and waiting for all
 * three to reach 100 is the obvious reading of the field names, and it may
 * never finish: Meta sends no webhook at all for a phase with no chats, so a
 * business with nothing older than a day never reports phase 1 or 2, and
 * under the documented meaning phase 0's last chunk reports the share of the
 * whole copy done by then, short of 100 whenever older chats follow. The row
 * then polled for a day and told the admin the copy had stalled.
 */
export function historyProgress(coexistence: Coexistence): HistoryProgress {
  const slot = coexistence.syncs.history;
  const requested = Boolean(slot && 'requestId' in slot && slot.requestId);
  const refused = slot && 'error' in slot && !requested ? slot.error : null;
  const declined = Boolean(slot?.declined);
  const chunks = slot?.chunks ?? 0;

  // Tolerant of shape like `parseCoexistence`: a hand-written string reads as
  // nothing reported rather than as NaN on the badge.
  const reported = Object.values(slot?.progressByPhase ?? {}).filter(Number.isFinite);
  const percent = Math.min(100, Math.max(0, ...reported));

  return {
    requested,
    refused,
    declined,
    chunks,
    percent,
    done: declined || (requested && percent >= 100),
  };
}

/**
 * Whether there is nothing more to wait for from the phone's chat history:
 * the copy reached 100%, or the business declined to share it. A copy that was
 * never requested, or that Meta refused, is not done — it is not started, and
 * the "copy again" button is what that case is for.
 */
export function historyDone(coexistence: Coexistence): boolean {
  return historyProgress(coexistence).done;
}

/**
 * What this number already holds a copy of: what this connection's copies
 * finished, and what an earlier connection's did (`carriedOver`). What a
 * reconnect leaves out of what it asks the phone for, and carries over in turn.
 *
 * Finished, not asked for. A request id says the phone was asked, not that it
 * answered: a history copy stalled at 30% — the case whose badge recommends a
 * reconnect — or a request whose answer was lost and that delivered nothing
 * would count as copied, and the reconnect would skip exactly the copy it was
 * made for, then never offer it again, since nothing carried over is "missed".
 *
 * - **History** reached 100% and was not declined. Not `historyDone`, which is
 *   true for a declined copy too — the business may say yes next time.
 * - **Contacts** delivered at least one. Meta sends no "finished" for the
 *   address book, and asking again re-sends contacts the helpdesk applies as
 *   upserts, so erring towards asking costs a few webhooks, where erring the
 *   other way costs the address book.
 */
export function copiedSoFar(coexistence: Coexistence): SyncType[] {
  const history = historyProgress(coexistence);
  const contacts = coexistence.syncs.contacts;
  const finished: Record<SyncType, boolean> = {
    history: history.requested && !history.declined && history.percent >= 100,
    contacts: Boolean(
      contacts && 'requestId' in contacts && contacts.requestId && (contacts.received ?? 0) > 0,
    ),
  };
  return SYNC_TYPES.filter(
    (type) => finished[type] || Boolean(coexistence.carriedOver?.includes(type)),
  );
}

/**
 * Whether the row offers Reconnect: going through Meta's window again is the
 * only way back for each of these, and the badge beside it says which.
 *
 * - **Disconnected** on the phone (`account_update`). Kept for an
 *   `ACCOUNT_OFFBOARDED` too, which Meta usually undoes on its own: if its
 *   `ACCOUNT_RECONNECTED` never arrives, this button is the way back.
 * - **A window that closed with something never copied** — `uncopiedAfterWindow`,
 *   so a number not on the app, or one whose copies an earlier connection
 *   made, is not offered a reconnect for a copy it does not need.
 * - **History declined on the phone.** Meta asks the phone once per
 *   connection, and the declined request holds a request id, so no copy button
 *   is offered for it inside the window or after. A reconnect asks again —
 *   `copiedSoFar` leaves declined history out of what it carries over.
 * - **History that stalled part-way** — chunks arrived, then nothing for a
 *   day. Its badge says a reconnect opens a new copy window, and the request
 *   id it holds means no copy button can; a reconnect asks again, because
 *   `copiedSoFar` counts only a copy that finished. Not a copy that never
 *   delivered a chunk: that is as likely a business with no chats to copy,
 *   for which a reconnect only unlinks the phone's devices again.
 *
 * Pure, so the page's condition has a test and the badges are drawn from the
 * same facts.
 */
export function needsReconnect(coexistence: Coexistence, now: Date): boolean {
  const history = historyProgress(coexistence);
  return (
    coexistence.disconnected !== undefined ||
    uncopiedAfterWindow(coexistence, now).length > 0 ||
    history.declined ||
    (historyStalled(coexistence, now) && history.chunks > 0)
  );
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

/**
 * The other side of `isSyncing`: requested, not done, and nothing for a day.
 * One rule, so the badge that says "stalled" and the Reconnect button beside
 * it cannot disagree about which copies it covers.
 */
function historyStalled(coexistence: Coexistence, now: Date): boolean {
  const slot = coexistence.syncs.history;
  if (!slot || !('requestId' in slot) || !slot.requestId) return false;
  if (historyDone(coexistence)) return false;
  return now.getTime() - lastMovedAt(slot) > SYNC_STALE_MS;
}

/**
 * Who Meta says disconnected the number, as a sentence for the badge — or
 * nothing where it does not say.
 *
 * Worth a sentence because the two answers send an admin to different people.
 * `USER` is something done with the phone: Disconnect under Settings → Account
 * → Business Platform in the app, a change of number, or the app registered
 * again on another phone — so whoever holds it knows which, and whether it was
 * meant. `SYSTEM` is Meta acting on its own, for a phone left unused for about
 * two weeks or for enforcement, which nobody at the business chose. The reason
 * code beside it in the badge (`PRIMARY_INACTIVITY`, …) is Meta's word for
 * which; this is the part an admin can act on without looking it up.
 *
 * A value Meta has not documented is quoted rather than guessed at, the way
 * the event and the reason are.
 */
function disconnectedBy(initiatedBy: string | null): string {
  if (!initiatedBy) return '';
  switch (initiatedBy.toUpperCase()) {
    case 'USER':
      return (
        ` Meta says this was done on the business's side: the number was disconnected in ` +
        `the WhatsApp Business app (Settings → Account → Business Platform), changed, or ` +
        `registered again on another phone — whoever holds the phone will know which.`
      );
    case 'SYSTEM':
      return (
        ` Meta says it disconnected the number itself, not anyone at the business — after ` +
        `the phone went unused for about two weeks, for example, or for enforcement.`
      );
    default:
      return ` Meta says it was started by ${initiatedBy}.`;
  }
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
  const connectedOn = `Connected through Meta on ${formatDateTime(coexistence.onboardedAt)}.`;
  const badges: CoexistenceBadge[] = [
    // A number Meta says is not on the Business app has no phone typing
    // replies and nothing to copy, so the badge that promises both would be
    // wrong about the one thing it is there to say.
    coexistence.notOnBusinessApp
      ? {
          label: 'connected through Meta',
          tone: 'brand',
          explain:
            `${connectedOn} Meta reported then that this number is not on the WhatsApp ` +
            `Business app, so it works as a Cloud API number: there is no phone to copy ` +
            `contacts or chats from, and console replies go out over Cloud API.`,
        }
      : {
          label: 'WhatsApp Business app',
          tone: 'brand',
          explain:
            `${connectedOn} The number keeps working on the phone: replies typed there count ` +
            `as the team's and appear on tickets as "WhatsApp Business app"; console replies go ` +
            `out over Cloud API.`,
        },
  ];

  if (coexistence.disconnected) {
    const { event, reason, initiatedBy, at } = coexistence.disconnected;
    const reported =
      `Meta reported ${event || 'a disconnection'}${reason ? ` (${reason})` : ''} on ` +
      `${formatDateTime(at || now)}.${disconnectedBy(initiatedBy)}`;
    // Only the one event Meta undoes by itself is told to wait. Anything else
    // — PARTNER_REMOVED, or an event this module has not met — gets the
    // instruction that is safe whatever happened: reconnect.
    badges.push(
      event === 'ACCOUNT_OFFBOARDED'
        ? {
            label: 'disconnected on the phone',
            tone: 'warning',
            explain:
              `${reported} That happens when the number moves to another phone or is ` +
              `registered again, and Meta reconnects it on its own, usually within minutes; ` +
              `sends from this number fail until it has, and this badge clears when it does. ` +
              `Press Reconnect only if the badge is still here after a few minutes — going ` +
              `through Meta's window again unlinks the phone's linked devices again.`,
          }
        : {
            label: 'disconnected on the phone',
            tone: 'danger',
            explain:
              `${reported} Sends from this number fail until it is reconnected through Meta — ` +
              `press Reconnect and complete the window again.`,
          },
    );
  }

  const history = historyProgress(coexistence);
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
      // Not "copy again": the declined request holds Meta's request id, and
      // Meta asks the phone once per connection, so no button here could ask
      // again — inside the 24 hours or after. Reconnecting does.
      explain:
        'The business chose not to share its chat history when the number was connected: ' +
        'the WhatsApp Business app asked on the phone and the answer was no. Meta asks the ' +
        'phone once per connection, so press Reconnect and choose to share the history when ' +
        'the WhatsApp Business app asks — the new connection asks for it again, and contacts ' +
        'already copied are not copied twice.',
    });
  } else if (history.requested && history.done) {
    badges.push({
      label: 'history copied',
      tone: 'success',
      explain: `Up to six months of chats arrived from the phone in ${history.chunks} chunk${
        history.chunks === 1 ? '' : 's'
      }. Each past conversation is a resolved ticket.`,
    });
  } else if (history.requested && historyStalled(coexistence, now)) {
    badges.push(
      history.chunks === 0
        ? {
            // Not "stalled", and no Reconnect (`needsReconnect`): Meta sends
            // nothing at all for a business with no chats in six months, which
            // looks exactly like a phone that was never opened. Warning about
            // the first sends an admin through Meta's window for nothing, and
            // that unlinks the phone's devices.
            label: 'no history arrived',
            tone: 'neutral',
            explain:
              'Nothing has arrived from the phone in the day since the chat history was ' +
              'requested. Either the business had no chats in the last six months — Meta then ' +
              'sends nothing — or the WhatsApp Business app has not been open on the phone ' +
              'since; the copy only runs while it is, so open it and the copy starts.',
          }
        : {
            label: `history stalled at ${history.percent}%`,
            tone: 'warning',
            explain:
              'Nothing has arrived from the phone for a day. The copy only runs while the ' +
              'WhatsApp Business app is open on the phone; open it and the copy resumes. ' +
              'If it was open all along, reconnecting the number opens a new copy window.',
          },
    );
  } else if (history.requested && !history.done) {
    badges.push({
      label:
        history.chunks === 0
          ? 'copying history · waiting for the phone'
          : `copying history · ${history.percent}%`,
      tone: 'pending',
      explain:
        'The phone is sending up to six months of chats. Keep the WhatsApp Business app open ' +
        'on the phone until it reaches 100% — it can take hours.',
    });
  }

  // A slot holds a request id or an error, never both: a success clears the
  // error and a refusal never overwrites a request (`recordSyncRequest`).
  const contacts = coexistence.syncs.contacts;
  if (contacts && 'requestId' in contacts && contacts.requestId) {
    const received = contacts.received ?? 0;
    const entries = `${received} address-book entr${received === 1 ? 'y' : 'ies'}`;
    badges.push(
      received > 0
        ? {
            label: entries,
            tone: 'neutral',
            // Entries, not people: the counter adds every entry the phone
            // sends, and one sent again or edited later counts again
            // (`recordContactSync`).
            explain:
              `${entries} received from the phone, each applied to the contact it names as ` +
              `the business saved it. An entry the phone sends again, or edits later, is ` +
              `counted again, so this is not a count of distinct people.`,
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

  // What an earlier connection copied and this one has not asked for again: a
  // fresh reconnect's `syncs` are empty, and without this the row would say
  // nothing at all about chats the helpdesk already holds.
  const carried = (coexistence.carriedOver ?? []).filter((type) => {
    const slot = coexistence.syncs[type];
    return !(slot && 'requestId' in slot && slot.requestId);
  });
  if (carried.length > 0) {
    const both = carried.length === SYNC_TYPES.length;
    const subject = both
      ? 'contacts and chat history were'
      : carried[0] === 'contacts'
        ? 'contacts were'
        : 'chat history was';
    badges.push({
      label: `${both ? 'contacts and history' : carried[0]} copied before`,
      tone: 'neutral',
      explain:
        `The ${subject} copied when this number was connected before, so this connection did ` +
        `not ask the phone again — asking re-sends all of it. Copying again is offered on this ` +
        `row in the 24 hours after connecting.`,
    });
  }

  const neverCopied = uncopiedAfterWindow(coexistence, now);
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
