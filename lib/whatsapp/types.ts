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

export type WhatsAppValue = {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WhatsAppContactProfile[];
  messages?: WhatsAppInboundMessage[];
  message_echoes?: WhatsAppEcho[];
  statuses?: WhatsAppStatus[];
  errors?: { code: number; title: string; message?: string }[];
};

export type WhatsAppChange = {
  field?: string;
  value?: WhatsAppValue;
};

export type WhatsAppWebhookPayload = {
  object?: string;
  entry?: { id?: string; changes?: WhatsAppChange[] }[];
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

export type NormalisedWebhook = {
  messages: NormalisedInboundMessage[];
  /** Messages sent from our own number, by us or by another service on it. */
  echoes: NormalisedEcho[];
  statuses: NormalisedStatus[];
  /** Account-level errors Meta reports outside any message. */
  errors: string[];
};
