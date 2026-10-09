/**
 * Meta Cloud API shapes, hand-written rather than generated.
 *
 * Meta's webhook payload is deeply nested and only loosely versioned: fields
 * appear over time and message types are added without notice. Everything here
 * is therefore optional at the edges, and `parse.ts` narrows it — an unknown
 * message type must degrade to a placeholder, never throw, because throwing in
 * the webhook path means Meta retries the whole batch forever.
 */

export type WhatsAppMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'button'
  | 'interactive'
  | 'reaction'
  | 'order'
  | 'system'
  | 'unsupported';

/** Media payloads share a shape across image/video/audio/document/sticker. */
export type WhatsAppMediaObject = {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
};

export type WhatsAppInboundMessage = {
  /** `wamid.…` — globally unique, and our idempotency key. */
  id: string;
  from: string;
  /** Unix seconds, as a string. */
  timestamp: string;
  type: WhatsAppMessageType | string;

  text?: { body: string };
  image?: WhatsAppMediaObject;
  video?: WhatsAppMediaObject;
  audio?: WhatsAppMediaObject;
  document?: WhatsAppMediaObject;
  sticker?: WhatsAppMediaObject;

  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: unknown[];
  reaction?: { message_id: string; emoji?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  order?: unknown;
  system?: { body?: string; type?: string; wa_id?: string };
  /**
   * A message changed or withdrawn after it was sent — supported once a number
   * runs on the WhatsApp Business app and Cloud API together.
   */
  edit?: { original_message_id?: string; message?: WhatsAppInboundMessage };
  revoke?: { original_message_id?: string };
  errors?: { code: number; title: string; message?: string; error_data?: { details?: string } }[];

  /** Present when the customer replied to a specific earlier message. */
  context?: { from?: string; id?: string; forwarded?: boolean; frequently_forwarded?: boolean };
};

/**
 * An echo of a message sent *from* our own number.
 *
 * Meta delivers these under the `message_echoes` webhook field, which exists for
 * exactly the case where more than one application sends on a number: the
 * business number appears as `from` and the customer as `to`. Structurally it is
 * an ordinary message, so it reuses the same content fields and the same
 * `displayText`.
 */
export type WhatsAppEcho = WhatsAppInboundMessage & {
  /** The customer the message went to. Absent on `messages`-array echoes. */
  to?: string;
  /**
   * How the message came to be — Meta sends e.g. `created_by_1p_bot`.
   *
   * Worth keeping on a mirrored number, where it is the only thing in the
   * payload that says whether the bot generated this or a person in the other
   * service typed it. Stored verbatim rather than interpreted: the value set is
   * Meta's and undocumented enough that mapping it to our own words would be
   * guessing.
   */
  message_creation_type?: string;
};

export type WhatsAppStatus = {
  /** The wamid of the *outbound* message this status refers to. */
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  timestamp: string;
  recipient_id: string;
  conversation?: { id: string; origin?: { type?: string }; expiration_timestamp?: string };
  pricing?: { billable?: boolean; category?: string; pricing_model?: string };
  errors?: { code: number; title: string; message?: string; error_data?: { details?: string } }[];
};

export type WhatsAppContactProfile = {
  profile?: { name?: string };
  /** The customer's phone number in E.164 without '+'. */
  wa_id: string;
};

type WhatsAppError = {
  code: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
};

/**
 * One message out of a number's chat history, copied from the WhatsApp Business
 * app after a coexistence onboarding. Structurally an ordinary message — `from`
 * is the business for what it sent and the customer for what they sent — with
 * the phone's own delivery state, and `media_placeholder` where a file was.
 */
export type WhatsAppHistoryMessage = WhatsAppEcho & {
  history_context?: { status?: string };
};

/** One `history` webhook's chunk: some threads, and how far the copy has got. */
export type WhatsAppHistoryChunk = {
  metadata?: { phase?: number; chunk_order?: number; progress?: number };
  threads?: { id?: string; messages?: WhatsAppHistoryMessage[] }[];
  /** Present instead of threads when the business declined to share (2593109). */
  errors?: WhatsAppError[];
};

/** One contact from the phone's address book (`smb_app_state_sync`). */
export type WhatsAppStateSyncItem = {
  type?: string;
  contact?: { full_name?: string; first_name?: string; phone_number?: string };
  action?: string;
  metadata?: { timestamp?: string | number };
};

export type WhatsAppValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WhatsAppContactProfile[];
  messages?: WhatsAppInboundMessage[];
  message_echoes?: WhatsAppEcho[];
  statuses?: WhatsAppStatus[];
  errors?: { code: number; title: string; message?: string }[];

  /** `history`: the copy of the phone's chats. */
  history?: WhatsAppHistoryChunk[];
  /** `smb_app_state_sync`: the phone's contacts, and later changes to them. */
  state_sync?: WhatsAppStateSyncItem[];

  /** `account_update`: what happened to the account. */
  event?: string;
  /** `account_update`'s business number, on the coexistence events. */
  phone_number?: string;
  waba_info?: { waba_id?: string; owner_business_id?: string };
  disconnection_info?: { reason?: string; initiated_by?: string };
};

export type WhatsAppChange = {
  field?: string;
  value?: WhatsAppValue;
};

export type WhatsAppWebhookPayload = {
  object?: string;
  entry?: { id?: string; time?: number | string; changes?: WhatsAppChange[] }[];
};

// --- Normalised forms the rest of the app works with -----------------------

export type NormalisedMedia = {
  /** Meta media id; the download URL is fetched separately and expires fast. */
  mediaId: string;
  mimeType: string | null;
  filename: string | null;
  sha256: string | null;
  /** True for voice notes, which render differently from ordinary audio. */
  isVoice: boolean;
};

/**
 * A pin the customer dropped, kept as coordinates rather than flattened to prose.
 *
 * `displayText` also renders a location into `body_text` for search and for any
 * consumer that only has text — this is the same pin, structured, so the console
 * can offer a map link instead of fourteen digits an agent has to copy out.
 */
export type NormalisedLocation = {
  latitude: number;
  longitude: number;
  /** The place name, when the customer picked a place rather than dropping a pin. */
  name: string | null;
  /** Meta's geocoded address, when it sends one. */
  address: string | null;
};

export type NormalisedInboundMessage = {
  wamid: string;
  /** E.164 without '+', as Meta sends it. */
  from: string;
  phoneNumberId: string | null;
  profileName: string | null;
  sentAt: Date;

  type: WhatsAppMessageType | string;
  /** Display text: the body, the caption, the button title, or a placeholder. */
  text: string;
  media: NormalisedMedia | null;
  location: NormalisedLocation | null;

  /** wamid of the message this one replies to, when the customer used reply. */
  replyToWamid: string | null;

  /** Everything not modelled above, kept on messages.meta for support triage. */
  raw: Record<string, unknown>;
};

/**
 * A message the bot sent, normalised.
 *
 * Separate from `NormalisedInboundMessage` because the customer is on the other
 * side of it: `to` identifies the contact rather than `from`, and treating the
 * two shapes as one is how an echo ends up filed as a message from our own
 * phone number.
 */
export type NormalisedEcho = {
  wamid: string;
  /** The customer this went to — who the conversation belongs to. */
  to: string;
  /** Our own number it was sent from, as Meta reports it. */
  from: string | null;
  phoneNumberId: string | null;
  sentAt: Date;

  type: WhatsAppMessageType | string;
  text: string;
  media: NormalisedMedia | null;
  location: NormalisedLocation | null;
  replyToWamid: string | null;
  /** Meta's own account of how the message was created, when it sends one. */
  creationType: string | null;
  raw: Record<string, unknown>;
};

export type NormalisedStatus = {
  wamid: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  at: Date;
  recipientId: string;
  /** Meta's error, flattened for display on the message row. */
  error: string | null;
  /** Meta's own window expiry, when it reports one. */
  conversationExpiresAt: Date | null;
};

/**
 * One message of a number's copied history, with the customer it belongs to
 * resolved: the thread's id, which is the customer whichever side wrote.
 */
export type NormalisedHistoryMessage = {
  wamid: string;
  /** The customer — the thread — whichever side wrote this message. */
  customer: string;
  direction: 'inbound' | 'outbound';
  sentAt: Date;
  type: WhatsAppMessageType | string;
  text: string;
  /** The phone had a file here that the copy does not carry. */
  mediaPlaceholder: boolean;
  location: NormalisedLocation | null;
  replyToWamid: string | null;
  /** The phone's own state for it — READ, DELIVERED, PLAYED, ERROR, … */
  phoneStatus: string | null;
  raw: Record<string, unknown>;
};

export type NormalisedHistoryChunk = {
  phoneNumberId: string | null;
  /** 0: the last day; 1: up to 90 days; 2: up to 180 days. */
  phase: number | null;
  chunkOrder: number | null;
  /**
   * 0–100, the whole copy's percentage rather than this phase's: 100 means the
   * copy is complete. A phase with no chats sends no webhook at all, so its
   * own figure may never arrive (`historyProgress`).
   */
  progress: number | null;
  messages: NormalisedHistoryMessage[];
  /** The business turned history sharing off on the phone. */
  declined: { code: number; message: string } | null;
};

/**
 * The file behind a `media_placeholder`, sent separately under the same
 * `history` field — as a top-level `messages` array, which is why that array
 * means something different under this field than under `messages`.
 */
export type NormalisedHistoryMedia = {
  wamid: string;
  phoneNumberId: string | null;
  text: string;
  media: NormalisedMedia;
};

export type NormalisedContactSync = {
  phoneNumberId: string | null;
  /** The contact's number, as the phone's address book holds it. */
  phone: string;
  name: string | null;
  action: 'add' | 'remove';
  at: Date;
};

export type NormalisedAccountUpdate = {
  /** `waba_info.waba_id` when Meta names it, else the entry's id. */
  wabaId: string | null;
  /** The business number, when the event names one. */
  phoneNumber: string | null;
  event: string;
  reason: string | null;
  initiatedBy: string | null;
  at: Date;
};

export type NormalisedWebhook = {
  messages: NormalisedInboundMessage[];
  /** Messages sent from our own number, by us or by another service on it. */
  echoes: NormalisedEcho[];
  statuses: NormalisedStatus[];
  /** Account-level errors Meta reports outside any message. */
  errors: string[];
  history: NormalisedHistoryChunk[];
  historyMedia: NormalisedHistoryMedia[];
  contactSyncs: NormalisedContactSync[];
  accountUpdates: NormalisedAccountUpdate[];
};
