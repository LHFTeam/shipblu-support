/**
 * Facebook and Instagram, which Meta delivers through one webhook shape with
 * two objects: `page` for a Facebook Page and `instagram` for an Instagram
 * professional account.
 *
 * Both carry two unrelated kinds of event in the same envelope:
 *
 *   entry[].messaging[]  — direct messages (Messenger inbox, IG Direct)
 *   entry[].changes[]    — comments on posts, and other page activity
 *
 * They are normalised separately because they behave differently: a DM is a
 * private thread with one customer, while a comment is public, belongs to a
 * post, and can be answered in public or taken private exactly once.
 */

export type MetaPlatform = 'facebook' | 'instagram';

// --- Raw webhook envelope ---------------------------------------------------

export type MetaWebhookPayload = {
  object?: string;
  entry?: MetaEntry[];
};

export type MetaEntry = {
  id?: string;
  time?: number;
  messaging?: MetaMessagingEvent[];
  /**
   * The same events, delivered to an app that does *not* hold thread control.
   *
   * Not a platform quirk and not an alternative spelling of `messaging`: it is
   * Meta's handover protocol saying another app owns this inbox. Everything
   * here is readable and nothing here is answerable — see `lib/meta/thread.ts`.
   */
  standby?: MetaMessagingEvent[];
  changes?: MetaChange[];
};

export type MetaMessagingEvent = {
  sender?: { id?: string; username?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    attachments?: MetaRawAttachment[];
    reply_to?: { mid?: string; story?: unknown };
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
  };
  postback?: { mid?: string; title?: string; payload?: string };
  reaction?: { mid?: string; action?: string; emoji?: string; reaction?: string };
  delivery?: { mids?: string[]; watermark?: number };
  read?: { mids?: string[]; watermark?: number };
  /**
   * Conversation Routing, delivered on the `messaging_handovers` field.
   *
   * Three shapes rather than one: two of them report a move that has happened
   * and name both apps, while `request_thread_control` reports an *ask* — it
   * reaches the current owner and names only who is asking, because nothing has
   * moved yet.
   */
  pass_thread_control?: MetaHandover;
  take_thread_control?: MetaHandover;
  request_thread_control?: { requested_owner_app_id?: string | number; metadata?: string };
};

export type MetaHandover = {
  /** Null when the thread was idle, so nobody was holding it. */
  previous_owner_app_id?: string | number | null;
  new_owner_app_id?: string | number | null;
  metadata?: string;
};

export type MetaRawAttachment = {
  type?: string;
  payload?: { url?: string; sticker_id?: number; title?: string };
};

export type MetaChange = {
  field?: string;
  value?: MetaChangeValue;
};

export type MetaChangeValue = {
  /** Facebook feed. */
  item?: string;
  verb?: string;
  post_id?: string;
  comment_id?: string;
  parent_id?: string;
  created_time?: number;
  message?: string;
  from?: { id?: string; name?: string; username?: string };
  /** Instagram comments. */
  id?: string;
  text?: string;
  media?: { id?: string; media_product_type?: string };
};

// --- Normalised ------------------------------------------------------------

export type MetaAttachment = {
  type: 'image' | 'video' | 'audio' | 'file' | 'share' | 'story' | 'sticker' | 'unsupported';
  url: string | null;
  title: string | null;
};

export type NormalisedDirectMessage = {
  platform: MetaPlatform;
  /** Meta's message id. The idempotency key for ingest. */
  mid: string;
  /** Page-scoped id of the customer. Stable per page, useless across pages. */
  from: string;
  /** The page or Instagram account the message arrived on. */
  accountId: string | null;
  /**
   * Arrived in the handover protocol's `standby` array, meaning another app
   * holds thread control and this one may read the thread but not answer it.
   */
  standby: boolean;
  senderName: string | null;
  sentAt: Date;
  text: string;
  attachments: MetaAttachment[];
  replyToMid: string | null;
  raw: Record<string, unknown>;
};

export type NormalisedComment = {
  platform: MetaPlatform;
  commentId: string;
  /**
   * The comment this one replies to, or null for a top-level comment. Used to
   * group a thread into one ticket rather than one ticket per reply.
   */
  parentCommentId: string | null;
  postId: string | null;
  from: string;
  fromName: string | null;
  text: string;
  createdAt: Date;
  /** `add`, `edited`, `remove`, `hide` — only `add` opens or extends a ticket. */
  verb: string;
  raw: Record<string, unknown>;
};

/**
 * A thread control move Meta told us about.
 *
 * `newOwnerAppId` null means the thread went idle. A `requested` event moves
 * nothing — it is another app asking us, as the current owner, to hand over —
 * and is normalised alongside the other two so a handler can see the whole
 * conversation about ownership in one place rather than in two.
 */
export type NormalisedHandover = {
  platform: MetaPlatform;
  kind: 'passed' | 'taken' | 'requested';
  /** The customer whose thread moved. Page-scoped, as everything else here is. */
  psid: string;
  accountId: string | null;
  previousOwnerAppId: string | null;
  newOwnerAppId: string | null;
  /** Who is asking, on a `requested` event. Null on the other two. */
  requestedByAppId: string | null;
  metadata: string | null;
  at: Date;
};

export type NormalisedReceipt = {
  platform: MetaPlatform;
  kind: 'delivered' | 'read';
  mids: string[];
  /** Everything sent before this instant, when Meta reports no explicit mids. */
  watermark: Date | null;
};

export type NormalisedMetaWebhook = {
  messages: NormalisedDirectMessage[];
  comments: NormalisedComment[];
  receipts: NormalisedReceipt[];
  handovers: NormalisedHandover[];
  /** Echoes of our own outbound messages, counted but never ingested. */
  echoes: number;
};
