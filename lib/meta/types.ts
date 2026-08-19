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
  /** Instagram uses this name for DMs on some API versions. */
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
  /** Echoes of our own outbound messages, counted but never ingested. */
  echoes: number;
};
