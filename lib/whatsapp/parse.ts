import { mimeEssence } from '@/lib/http/mime';
import { parseCoordinates } from '@/lib/tickets/shared-location';
import type {
  NormalisedAccountUpdate,
  NormalisedContactSync,
  NormalisedEcho,
  NormalisedHistoryChunk,
  NormalisedHistoryMessage,
  NormalisedInboundMessage,
  NormalisedLocation,
  NormalisedMedia,
  NormalisedStatus,
  NormalisedWebhook,
  WhatsAppEcho,
  WhatsAppHistoryChunk,
  WhatsAppInboundMessage,
  WhatsAppMediaObject,
  WhatsAppStateSyncItem,
  WhatsAppStatus,
  WhatsAppValue,
  WhatsAppWebhookPayload,
} from './types';

/**
 * Flattens Meta's nested webhook envelope into the messages and statuses the
 * ingest pipeline cares about.
 *
 * One batch can carry several entries, several changes per entry, and both
 * inbound messages and delivery statuses in the same change — so this returns
 * lists, not a single message. Nothing here throws: a payload we cannot read is
 * an empty result, because a throw in the webhook path makes Meta redeliver the
 * whole batch, including the parts we did understand.
 */

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;

/** Meta's code for a business that turned history sharing off on the phone. */
const DECLINED_HISTORY = 2593109;

export function parseWebhook(payload: unknown): NormalisedWebhook {
  const result: NormalisedWebhook = {
    messages: [],
    echoes: [],
    statuses: [],
    errors: [],
    history: [],
    historyMedia: [],
    contactSyncs: [],
    accountUpdates: [],
  };

  if (!isObject(payload)) return result;
  const body = payload as WhatsAppWebhookPayload;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      // The field decides what the arrays mean, so it is read first. Under
      // `history`, a top-level `messages` array is the file behind a copied
      // media placeholder — read as live messages, six-month-old media would
      // reopen tickets and start the 24-hour window.
      if (change.field === 'history') {
        parseHistory(value, result);
        continue;
      }
      if (change.field === 'smb_app_state_sync') {
        parseStateSync(value, result);
        continue;
      }
      if (change.field === 'account_update') {
        const update = normaliseAccountUpdate(value, entry.id, entry.time);
        if (update) result.accountUpdates.push(update);
        continue;
      }

      const phoneNumberId = value.metadata?.phone_number_id ?? null;

      // Meta sends the profile name once per batch in `contacts`, keyed by the
      // customer's number, not on the message itself.
      const profileNames = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        if (contact.wa_id && contact.profile?.name) {
          profileNames.set(contact.wa_id, contact.profile.name);
        }
      }

      // Our own number, for telling an echo from a customer message. Meta
      // formats it for display — "+20 100 123 4567" — so both sides of the
      // comparison are reduced to digits.
      const businessNumber = digits(value.metadata?.display_phone_number);

      // The only customer in the batch, when there is exactly one. An echo that
      // arrives without a `to` has no other way to name who it went to, and
      // guessing between several would attach it to the wrong conversation.
      const soleContact = value.contacts?.length === 1 ? value.contacts[0]!.wa_id : null;

      // `message_echoes` is the array `smb_message_echoes` carries: a reply
      // the business typed on the WhatsApp Business app, on a number connected
      // through coexistence. The older `message_echoes` field Meta discontinued
      // used the same array, so stored deliveries of either replay the same way.
      for (const echo of value.message_echoes ?? []) {
        const normalised = normaliseEcho(echo, phoneNumberId, soleContact);
        if (normalised) result.echoes.push(normalised);
      }

      for (const message of value.messages ?? []) {
        // A message from our own number is an echo wherever it arrives, and
        // this branch is load-bearing on its own terms rather than as a
        // fallback for the array above. Treating `messages` as unconditionally
        // inbound is what would file our own outbound as a customer message —
        // inventing a contact for our own phone number and opening a ticket
        // from ourselves. That stays true now that `message_echoes` is
        // discontinued: the risk was never that Meta used the wrong array, it
        // is that anything we send can come back under `messages`.
        if (businessNumber && digits(message.from) === businessNumber) {
          const normalised = normaliseEcho(message, phoneNumberId, soleContact);
          if (normalised) result.echoes.push(normalised);
          continue;
        }

        const normalised = normaliseMessage(message, phoneNumberId, profileNames);
        if (normalised) result.messages.push(normalised);
      }

      for (const status of value.statuses ?? []) {
        const normalised = normaliseStatus(status);
        if (normalised) result.statuses.push(normalised);
      }

      for (const error of value.errors ?? []) {
        result.errors.push(
          `${error.code}: ${error.title}${error.message ? ` — ${error.message}` : ''}`,
        );
      }
    }
  }

  return result;
}

/**
 * A `history` change: chunks of copied chats, the business declining to share
 * them, or the file behind a copied placeholder.
 *
 * Direction comes from comparing `from` with the business's own number, digits
 * only, the way the echo branch below tells our own messages from a
 * customer's. The thread's id is the customer either way.
 */
function parseHistory(value: WhatsAppValue, result: NormalisedWebhook): void {
  const phoneNumberId = value.metadata?.phone_number_id ?? null;
  const businessNumber = digits(value.metadata?.display_phone_number);

  for (const chunk of value.history ?? []) {
    result.history.push(normaliseHistoryChunk(chunk, phoneNumberId, businessNumber));
  }

  for (const message of value.messages ?? []) {
    const media = extractMedia(message);
    if (!message?.id || !media) continue;
    result.historyMedia.push({
      wamid: message.id,
      phoneNumberId,
      text: displayText(message),
      media,
    });
  }
}

function normaliseHistoryChunk(
  chunk: WhatsAppHistoryChunk,
  phoneNumberId: string | null,
  businessNumber: string | null,
): NormalisedHistoryChunk {
  const declined = (chunk.errors ?? []).find((error) => error?.code === DECLINED_HISTORY);
  const messages: NormalisedHistoryMessage[] = [];

  for (const thread of chunk.threads ?? []) {
    for (const message of thread.messages ?? []) {
      if (!message?.id) continue;
      const outbound = businessNumber !== null && digits(message.from) === businessNumber;
      // The thread is the customer; a message without one names them itself.
      const customer = thread.id ?? (outbound ? message.to : message.from);
      if (!customer) continue;

      messages.push({
        wamid: message.id,
        customer,
        direction: outbound ? 'outbound' : 'inbound',
        sentAt: parseTimestamp(message.timestamp),
        type: message.type ?? 'unsupported',
        text: displayText(message),
        mediaPlaceholder: message.type === 'media_placeholder',
        location: extractLocation(message),
        replyToWamid: message.context?.id ?? null,
        phoneStatus: message.history_context?.status ?? null,
        raw: message as unknown as Record<string, unknown>,
      });
    }
  }

  return {
    phoneNumberId,
    phase: numberOrNull(chunk.metadata?.phase),
    chunkOrder: numberOrNull(chunk.metadata?.chunk_order),
    progress: numberOrNull(chunk.metadata?.progress),
    messages,
    declined: declined
      ? {
          code: declined.code,
          message: declined.message ?? declined.title ?? 'History sharing is turned off',
        }
      : null,
  };
}

function parseStateSync(value: WhatsAppValue, result: NormalisedWebhook): void {
  const phoneNumberId = value.metadata?.phone_number_id ?? null;
  for (const item of value.state_sync ?? []) {
    const sync = normaliseContactSync(item, phoneNumberId);
    if (sync) result.contactSyncs.push(sync);
  }
}

function normaliseContactSync(
  item: WhatsAppStateSyncItem,
  phoneNumberId: string | null,
): NormalisedContactSync | null {
  if (item?.type !== 'contact') return null;
  const phone = item.contact?.phone_number;
  if (!phone || (item.action !== 'add' && item.action !== 'remove')) return null;

  return {
    phoneNumberId,
    phone,
    name: trimmedOrNull(item.contact?.full_name) ?? trimmedOrNull(item.contact?.first_name),
    action: item.action,
    at: parseTimestamp(String(item.metadata?.timestamp ?? '')),
  };
}

/**
 * An `account_update`. The WABA is `waba_info.waba_id` where Meta names it — on
 * the partner events its entry is the business portfolio — and the entry's id
 * otherwise, which is the WABA on the coexistence events (Meta's own samples
 * disagree on this, so both are read).
 */
function normaliseAccountUpdate(
  value: WhatsAppValue,
  entryId: string | undefined,
  entryTime: number | string | undefined,
): NormalisedAccountUpdate | null {
  if (!value.event) return null;
  return {
    wabaId: value.waba_info?.waba_id ?? entryId ?? null,
    phoneNumber: value.phone_number ?? null,
    event: value.event,
    reason: value.disconnection_info?.reason ?? null,
    initiatedBy: value.disconnection_info?.initiated_by ?? null,
    at: parseTimestamp(entryTime === undefined ? undefined : String(entryTime)),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normaliseMessage(
  message: WhatsAppInboundMessage,
  phoneNumberId: string | null,
  profileNames: Map<string, string>,
): NormalisedInboundMessage | null {
  // Without a wamid there is no idempotency key, and ingesting it would risk
  // duplicating the message on every redelivery. Dropping is the safer failure.
  if (!message?.id || !message.from) return null;

  const media = extractMedia(message);

  return {
    wamid: message.id,
    from: message.from,
    phoneNumberId,
    profileName: profileNames.get(message.from) ?? null,
    sentAt: parseTimestamp(message.timestamp),
    type: message.type ?? 'unsupported',
    text: displayText(message),
    media,
    location: extractLocation(message),
    replyToWamid: message.context?.id ?? null,
    raw: message as unknown as Record<string, unknown>,
  };
}

function normaliseEcho(
  echo: WhatsAppEcho,
  phoneNumberId: string | null,
  soleContact: string | null,
): NormalisedEcho | null {
  if (!echo?.id) return null;

  // Without a recipient there is no conversation to file this under. Dropping is
  // right: the alternative is attaching one side of somebody's chat to whichever
  // conversation happened to be nearby.
  const to = echo.to ?? soleContact;
  if (!to) return null;

  return {
    wamid: echo.id,
    to,
    from: echo.from ?? null,
    phoneNumberId,
    sentAt: parseTimestamp(echo.timestamp),
    type: echo.type ?? 'unsupported',
    text: displayText(echo),
    media: extractMedia(echo),
    location: extractLocation(echo),
    replyToWamid: echo.context?.id ?? null,
    creationType: echo.message_creation_type ?? null,
    raw: echo as unknown as Record<string, unknown>,
  };
}

/** Phone numbers for comparison only — Meta formats them for display. */
function digits(value: string | undefined | null): string | null {
  if (!value) return null;
  const stripped = value.replace(/\D/g, '');
  return stripped || null;
}

/**
 * What the agent sees in the conversation list.
 *
 * Every message type resolves to *something* readable — an agent scanning the
 * inbox should never see a blank row and have to open it to find out it was a
 * location pin.
 */
export function displayText(message: WhatsAppInboundMessage): string {
  switch (message.type) {
    case 'text':
      return message.text?.body ?? '';

    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const media = message[message.type as (typeof MEDIA_TYPES)[number]];
      const caption = media?.caption?.trim();
      if (caption) return caption;
      if (message.type === 'document' && media?.filename) return `[document: ${media.filename}]`;
      if (message.type === 'audio' && media?.voice) return '[voice note]';
      return `[${message.type}]`;
    }

    case 'location': {
      const { latitude, longitude, name, address } = message.location ?? {};
      const label = [name, address].filter(Boolean).join(', ');
      const coords = latitude != null && longitude != null ? `${latitude}, ${longitude}` : '';
      return `[location${label ? `: ${label}` : ''}${coords ? ` (${coords})` : ''}]`;
    }

    case 'contacts':
      return `[shared ${message.contacts?.length ?? 0} contact card(s)]`;

    case 'reaction':
      return `[reacted ${message.reaction?.emoji ?? ''}]`.replace(' ]', ']');

    case 'button':
      return message.button?.text ?? '[button reply]';

    case 'interactive':
      return (
        message.interactive?.button_reply?.title ??
        message.interactive?.list_reply?.title ??
        '[interactive reply]'
      );

    case 'order':
      return '[order]';

    case 'system':
      return message.system?.body ?? '[system message]';

    // A copied chat's file, which the copy does not carry — the phone has it.
    case 'media_placeholder':
      return '[media]';

    // Edits and deletions, which a number on the Business app as well as Cloud
    // API can send. Shown as what they are rather than "unsupported": the
    // original is not rewritten, so the agent is told it changed.
    case 'revoke':
      return '[deleted a message]';

    case 'edit': {
      const edited = message.edit?.message;
      return `[edited a message${edited ? `: ${displayText({ ...edited, id: '', from: '', timestamp: '' })}` : ''}]`;
    }

    default: {
      // `unsupported` carries an error explaining what Meta refused to deliver;
      // showing it beats an opaque placeholder when a customer says "I sent it".
      const error = message.errors?.[0];
      if (error) return `[unsupported message: ${error.title}]`;
      return `[unsupported message type: ${message.type}]`;
    }
  }
}

function extractMedia(message: WhatsAppInboundMessage): NormalisedMedia | null {
  for (const type of MEDIA_TYPES) {
    const media = message[type] as WhatsAppMediaObject | undefined;
    if (media?.id) {
      return {
        mediaId: media.id,
        mimeType: normaliseMime(media.mime_type),
        // Meta only sends a filename for documents; the rest get one at download
        // time from the mime type, so the object key always has an extension.
        filename: media.filename ?? null,
        sha256: media.sha256 ?? null,
        isVoice: media.voice === true,
      };
    }
  }
  return null;
}

/**
 * The pin on a location message, kept as coordinates.
 *
 * `displayText` already renders one into `body_text`, but only as prose — the
 * numbers go in as characters and the structure is gone, so the console could
 * offer nothing better than `[location (30.0307677, 31.2345206)]` and an agent
 * chasing an address had to select it and paste it into a map by hand. Location
 * shares are a tenth of inbound volume on this channel, and on unstructured
 * Egyptian addresses the pin is usually the only part of the message that says
 * precisely where to go.
 *
 * Validation is `parseCoordinates`, shared with the reader and the backfill so
 * all three agree on what is usable. An unusable pair yields null and the
 * message still ingests with its text: a pin we cannot read is not a reason to
 * drop a customer's message.
 */
function extractLocation(message: WhatsAppInboundMessage): NormalisedLocation | null {
  const location = message?.location;
  if (!location) return null;

  const coordinates = parseCoordinates(location.latitude, location.longitude);
  if (!coordinates) return null;

  return {
    ...coordinates,
    name: trimmedOrNull(location.name),
    address: trimmedOrNull(location.address),
  };
}

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Meta appends codec parameters, e.g. `audio/ogg; codecs=opus`. Storage and the
 * Content-Type header want the bare type.
 */
function normaliseMime(mime: string | undefined): string | null {
  return mimeEssence(mime) || null;
}

function normaliseStatus(status: WhatsAppStatus): NormalisedStatus | null {
  if (!status?.id || !status.status) return null;
  if (!['sent', 'delivered', 'read', 'failed'].includes(status.status)) return null;

  const error = status.errors?.[0];

  return {
    wamid: status.id,
    status: status.status as NormalisedStatus['status'],
    at: parseTimestamp(status.timestamp),
    recipientId: status.recipient_id,
    error: error
      ? `${error.code}: ${error.title}${error.error_data?.details ? ` — ${error.error_data.details}` : ''}`
      : null,
    conversationExpiresAt: status.conversation?.expiration_timestamp
      ? parseTimestamp(status.conversation.expiration_timestamp)
      : null,
  };
}

/**
 * Meta sends Unix *seconds* as a string. Treating it as milliseconds — the easy
 * mistake — dates every message to 1970 and silently breaks the 24-hour window,
 * so an unparseable value falls back to now rather than to the epoch.
 */
export function parseTimestamp(timestamp: string | undefined): Date {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
