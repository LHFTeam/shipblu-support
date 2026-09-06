import type { MetaConnection } from './connection';

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
  postback?: { mid?: string; title?: string; payload?: string; referral?: MetaReferral };
  reaction?: { mid?: string; action?: string; emoji?: string; reaction?: string };
  /**
   * How the customer arrived: an m.me link carrying `ref`, a Click-to-Messenger
   * ad, or one of the website plugins. Delivered on its own for a returning
   * customer and nested inside `postback` when the same click also pressed Get
   * Started, which is why both spellings are read.
   */
  referral?: MetaReferral;
  delivery?: { mids?: string[]; watermark?: number };
  read?: { mids?: string[]; watermark?: number };
};

export type MetaReferral = {
  ref?: string;
  source?: string;
  type?: string;
  ad_id?: string;
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
  /**
   * The connection this delivery came in on.
   *
   * Carried through to the message row because it is the only place it is
   * knowable — the payloads are identical and only the signature differs — and
   * because `standby` below means nothing without it. Null only when replaying
   * a row stored before the two connections were told apart; a guess written
   * there would be indistinguishable from a fact afterwards.
   */
  connection: MetaConnection | null;
  /** Meta's message id. The idempotency key for ingest. */
  mid: string;
  /** Page-scoped id of the customer. Stable per page, useless across pages. */
  from: string;
  /** The page or Instagram account the message arrived on. */
  accountId: string | null;
  /**
   * Arrived in the handover protocol's `standby` array, meaning another app
   * holds thread control on **the connection above** — which is why the two
   * travel together. A Page's handover has no authority over a reply sent with
   * the Instagram account's own token.
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
  /** The connection this delivery came in on, null on a pre-migration replay. */
  connection: MetaConnection | null;
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

/**
 * A customer touching the thread without writing anything.
 *
 * Meta's messaging policy lists these alongside a message as things that open
 * the standard 24-hour window: tapping Get Started or any other button
 * (`postback`), arriving from an m.me `ref` link, a Click-to-Messenger ad or a
 * website plugin (`referral`), and reacting to a message (`reaction`). Every one
 * of them was previously dropped by the parser, which reads every event without
 * a `message` as nothing at all — so a customer who tapped a button existed to
 * this system only if they also typed.
 *
 * They are normalised apart from messages, and not turned into `messages` rows,
 * because none of them is something an agent can answer. A reaction rendered as
 * an inbound reply would be categorised, counted as support demand and answered.
 *
 * `opensWindow` is the distinction that matters, and it is not the same question
 * as "did the customer interact". See `applyMetaInteraction`.
 */
export type NormalisedInteraction = {
  platform: MetaPlatform;
  connection: MetaConnection | null;
  kind: 'postback' | 'referral' | 'reaction';
  /** Page-scoped id of the customer. */
  from: string;
  accountId: string | null;
  at: Date;
  /**
   * Whether this counts as the customer asking us something — which is both what
   * reopens the messaging window and what starts a next-response SLA clock.
   *
   * True for a postback and a referral: pressing Get Started or clicking an ad
   * to open a thread is somebody wanting an answer. False for a reaction, which
   * is an acknowledgement of an answer already given.
   */
  opensWindow: boolean;
  /** What to show on the timeline: a button's title, a reaction's emoji, a ref. */
  summary: string;
  /** Arrived in `standby`, so another app holds thread control on this connection. */
  standby: boolean;
  raw: Record<string, unknown>;
};

export type NormalisedMetaWebhook = {
  messages: NormalisedDirectMessage[];
  comments: NormalisedComment[];
  receipts: NormalisedReceipt[];
  interactions: NormalisedInteraction[];
  /** Echoes of our own outbound messages, counted but never ingested. */
  echoes: number;
};
