import type { MetaPlatform } from './types';

/**
 * What has been done to a public comment, and what is still in flight.
 *
 * Hiding and deleting are the two halves of `instagram_business_manage_comments`
 * that are not a reply, and they are the reason the permission is named *manage*
 * rather than *reply*. The console has been able to do neither: `hideComment`
 * has existed in `lib/meta/client.ts` since the channel landed and **nothing
 * ever imported it**, and there was no delete at all — the same shape of dead
 * scaffolding as `agents.presence` and `conversations.custom_fields` before
 * them.
 *
 * The state lives on the message's `meta`, beside the comment id it describes,
 * rather than in a column or a table of its own. A comment's moderation is a
 * property of that one comment and is read only when its bubble is rendered, so
 * a column would be null on every row in the system that is not a Meta comment —
 * of 152,000 messages, none today.
 *
 * `pending` is what makes the timeline honest while the job runs. The Graph call
 * belongs in a job (it is external and retryable, and Meta rate-limits), so
 * there is a second or two where the agent has asked and Meta has not answered.
 * Showing the comment as already hidden then would be a claim about what the
 * public can see, made before anybody knew — and hiding is precisely the thing
 * an agent needs to be *sure* of.
 */

export type ModerationAction = 'hide' | 'unhide' | 'delete';

export type CommentModeration = {
  hidden: boolean;
  /** Deleted at Meta. The message stays on the ticket; the comment is gone. */
  deleted: boolean;
  /** Asked for and not yet confirmed by Graph. */
  pending: ModerationAction | null;
  /** Graph's refusal, for the agent rather than for a log. */
  error: string | null;
  at: string | null;
  byAgentId: string | null;
};

const NONE: CommentModeration = {
  hidden: false,
  deleted: false,
  pending: null,
  error: null,
  at: null,
  byAgentId: null,
};

/** The comment a moderation request acts on, or null if this is not one. */
export type ModeratableComment = {
  platform: MetaPlatform;
  commentId: string;
};

/**
 * The comment a message names, if it names one.
 *
 * Read from `meta` rather than from `channelMessageId`, which holds the comment
 * id for an inbound comment and the *reply's* id once an outbound reply has been
 * accepted — moderating on that would hide our own answer instead of the
 * comment.
 */
export function moderatableComment(meta: unknown): ModeratableComment | null {
  if (!isObject(meta)) return null;
  if (meta.metaKind !== 'comment') return null;

  const commentId = typeof meta.commentId === 'string' ? meta.commentId : null;
  const platform =
    meta.platform === 'instagram' || meta.platform === 'facebook' ? meta.platform : null;

  if (!commentId || !platform) return null;
  return { platform, commentId };
}

export function readCommentModeration(meta: unknown): CommentModeration {
  if (!isObject(meta)) return NONE;
  const raw = meta.moderation;
  if (!isObject(raw)) return NONE;

  return {
    hidden: raw.hidden === true,
    deleted: raw.deleted === true,
    pending:
      raw.pending === 'hide' || raw.pending === 'unhide' || raw.pending === 'delete'
        ? raw.pending
        : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    at: typeof raw.at === 'string' ? raw.at : null,
    byAgentId: typeof raw.byAgentId === 'string' ? raw.byAgentId : null,
  };
}

/**
 * Whether an action is worth asking Meta for, given what is already true.
 *
 * A stale tab, a double-submit and a retried job are three different ways to
 * arrive at "hide something already hidden". This answers the first two, in the
 * action, before anything is enqueued; the handler answers the third by skipping
 * a job whose message is no longer pending. The UI never offers a control this
 * would refuse, which is a nicety rather than the guard — hiding the button stops
 * the honest path and nothing else.
 */
export function moderationRefusal(
  state: CommentModeration,
  action: ModerationAction,
): string | null {
  if (state.deleted) return 'That comment has already been deleted.';

  if (state.pending && state.pending !== action) {
    return `${labelFor(state.pending)} this comment is still in progress.`;
  }

  if (action === 'hide' && state.hidden && !state.pending) return 'That comment is already hidden.';
  if (action === 'unhide' && !state.hidden && !state.pending) {
    return 'That comment is not hidden.';
  }

  return null;
}

/** The state to store once an action has been asked for. */
export function requested(
  state: CommentModeration,
  action: ModerationAction,
  agentId: string,
  now: Date,
): CommentModeration {
  return {
    ...state,
    pending: action,
    error: null,
    at: now.toISOString(),
    byAgentId: agentId,
  };
}

/** The state to store once Graph has accepted it. */
export function settled(
  state: CommentModeration,
  action: ModerationAction,
  now: Date,
): CommentModeration {
  return {
    ...state,
    hidden: action === 'delete' ? state.hidden : action === 'hide',
    deleted: action === 'delete' ? true : state.deleted,
    pending: null,
    error: null,
    at: now.toISOString(),
  };
}

/**
 * The state to store once Graph has refused it.
 *
 * `hidden` and `deleted` are left exactly as they were: a failed hide has not
 * hidden anything, and writing the requested outcome anyway is how a console
 * comes to show a comment as hidden while it is still on the post.
 */
export function failed(state: CommentModeration, message: string): CommentModeration {
  return { ...state, pending: null, error: message.slice(0, 500) };
}

/** For a sentence, not for a badge. */
export function labelFor(action: ModerationAction): string {
  return action === 'hide' ? 'Hiding' : action === 'unhide' ? 'Unhiding' : 'Deleting';
}

/** The conversation event type recorded when an action succeeds. */
export function eventTypeFor(action: ModerationAction): string {
  return action === 'hide'
    ? 'comment_hidden'
    : action === 'unhide'
      ? 'comment_unhidden'
      : 'comment_deleted';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
