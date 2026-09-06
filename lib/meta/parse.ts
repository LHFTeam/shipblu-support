import type { MetaConnection } from './connection';
import type {
  MetaAttachment,
  MetaChange,
  MetaEntry,
  MetaMessagingEvent,
  MetaPlatform,
  MetaRawAttachment,
  MetaReferral,
  MetaWebhookPayload,
  NormalisedComment,
  NormalisedInteraction,
  NormalisedMetaWebhook,
  NormalisedReceipt,
} from './types';

/**
 * Flattens a Meta webhook batch into direct messages, comments, receipts and the
 * interactions that open a messaging window without being messages.
 *
 * Nothing here throws. A payload we cannot read becomes an empty result,
 * because throwing makes Meta redeliver the whole batch — including the parts
 * that were fine — and repeated failures eventually get the subscription
 * disabled.
 *
 * `connection` is passed in rather than derived. It is not in the payload —
 * both Instagram connections send the same body and differ only in the
 * signature — so the endpoint that verified it is the only thing that knows,
 * and it stores the answer on the row this parser is handed.
 */

const ATTACHMENT_TYPES = new Set(['image', 'video', 'audio', 'file', 'share', 'story', 'sticker']);

/** Comment events worth acting on. `edited` and `remove` are not new tickets. */
const OPENING_VERBS = new Set(['add']);

export function parseMetaWebhook(
  payload: unknown,
  connection: MetaConnection | null,
): NormalisedMetaWebhook {
  const result: NormalisedMetaWebhook = {
    messages: [],
    comments: [],
    receipts: [],
    interactions: [],
    echoes: 0,
  };

  if (!isObject(payload)) return result;
  const body = payload as MetaWebhookPayload;

  const platform = platformOf(body.object);
  if (!platform) return result;

  for (const entry of body.entry ?? []) {
    const accountId = entry.id ?? null;

    for (const event of entry.messaging ?? []) {
      readMessagingEvent(event, platform, connection, accountId, false, result);
    }

    // `standby` carries messages while another app holds the thread, which
    // happens when a Page runs more than one inbox tool. They are read-only for
    // us, but ingesting them keeps the ticket history complete — so the flag
    // travels with the message rather than the array being flattened into the
    // other one. Losing it here is what let a reply be composed against a
    // thread this app cannot send on, and Graph refuses that with nothing but
    // "An unknown error has occurred."
    for (const event of entry.standby ?? []) {
      readMessagingEvent(event, platform, connection, accountId, true, result);
    }

    for (const change of entry.changes ?? []) {
      const comment = readComment(change, platform, connection, entry);
      if (comment) result.comments.push(comment);
    }
  }

  return result;
}

function platformOf(object: string | undefined): MetaPlatform | null {
  if (object === 'page') return 'facebook';
  if (object === 'instagram') return 'instagram';
  return null;
}

function readMessagingEvent(
  event: MetaMessagingEvent,
  platform: MetaPlatform,
  connection: MetaConnection | null,
  accountId: string | null,
  standby: boolean,
  result: NormalisedMetaWebhook,
): void {
  if (!isObject(event)) return;

  if (event.delivery || event.read) {
    const receipt = readReceipt(event, platform);
    if (receipt) result.receipts.push(receipt);
    return;
  }

  const message = event.message;

  // Everything the customer can do to a thread *without* writing in it. Below
  // the receipts and above the message guard that used to be the end of this
  // function and dropped every one of them: Meta's messaging policy counts a
  // button press, an ad click and a reaction alongside a message as things that
  // open the standard window, and this parser saw none of them.
  //
  // Conditioned on there being no message rather than checked first, because
  // Meta can hang a `referral` on a message event — somebody arriving from an ad
  // and typing straight away — and a message read as an interaction would be a
  // customer's actual question silently not filed. A message is always the more
  // specific event.
  if (!message) {
    const interaction = readInteraction(event, platform, connection, standby);
    if (interaction) result.interactions.push(interaction);
    return;
  }

  // Meta echoes back everything the page sends, including our own agent
  // replies. Ingesting an echo would file our reply as if the customer had
  // written it, and then reply to ourselves forever.
  if (message.is_echo) {
    result.echoes += 1;
    return;
  }

  // A deleted message has no content to file and no id worth threading on.
  if (message.is_deleted) return;

  const from = event.sender?.id;
  if (!from || !message.mid) return;

  result.messages.push({
    platform,
    connection,
    mid: message.mid,
    from,
    accountId: event.recipient?.id ?? accountId,
    senderName: event.sender?.username ?? null,
    sentAt: fromEpoch(event.timestamp),
    text: displayText(event),
    attachments: (message.attachments ?? []).map(normaliseAttachment),
    replyToMid: message.reply_to?.mid ?? null,
    standby,
    raw: event as unknown as Record<string, unknown>,
  });
}

/**
 * A postback, a referral or a reaction, as one shape.
 *
 * Order matters. A single click can be both a referral and a postback — Meta
 * nests the referral inside the postback when somebody reaches the thread from
 * an ad and presses Get Started in the same motion — and it is one event, so the
 * postback wins and takes the referral's `ref` as its payload rather than
 * producing two.
 *
 * A reaction is only counted when the customer *adds* one. `action: 'unreact'`
 * is somebody taking a thumbs-up back, which is not them asking for anything and
 * reads on a timeline as noise.
 */
function readInteraction(
  event: MetaMessagingEvent,
  platform: MetaPlatform,
  connection: MetaConnection | null,
  standby: boolean,
): NormalisedInteraction | null {
  const from = event.sender?.id;
  if (!from) return null;

  const base = {
    platform,
    connection,
    from,
    at: fromEpoch(event.timestamp),
    standby,
  };

  if (event.postback) {
    return {
      ...base,
      kind: 'postback',
      opensWindow: true,
      summary:
        event.postback.title?.trim() ||
        describeReferral(event.postback.referral) ||
        event.postback.payload?.trim() ||
        'a button',
      payload: event.postback.payload?.trim() || event.postback.referral?.ref?.trim() || null,
    };
  }

  if (event.referral) {
    return {
      ...base,
      kind: 'referral',
      opensWindow: true,
      summary: describeReferral(event.referral),
      payload: event.referral.ref?.trim() || event.referral.ad_id?.trim() || null,
    };
  }

  if (event.reaction && event.reaction.action === 'react') {
    return {
      ...base,
      kind: 'reaction',
      // Deliberately false, and the one place these three part company. Meta
      // does count a reaction as opening the window, but `applyMetaInteraction`
      // also restarts the next-response SLA clock on this flag — and a customer
      // answering our reply with a thumbs-up has been served, not left waiting.
      // Measuring an agent as late for not answering 👍 is the worse error.
      opensWindow: false,
      summary: event.reaction.emoji || event.reaction.reaction || 'a reaction',
      payload: null,
    };
  }

  return null;
}

/** An arrival route, in the terms an agent reading the ticket would use. */
function describeReferral(referral: MetaReferral | undefined): string {
  if (!referral) return '';
  if (referral.ad_id) return `an ad (${referral.ad_id})`;
  if (referral.ref) return `a link (ref: ${referral.ref})`;
  return referral.source ? referral.source.toLowerCase() : 'a referral link';
}

/**
 * What the console shows for a message with no text of its own.
 *
 * An empty body renders as a blank bubble, which reads like a bug rather than
 * like a photo — so a message that is only an attachment says so.
 */
function displayText(event: MetaMessagingEvent): string {
  const message = event.message;
  const text = message?.text?.trim();
  if (text) return text;

  if (message?.is_unsupported) return '[unsupported message type]';

  const attachments = message?.attachments ?? [];
  if (attachments.length === 1) return `[${attachments[0]?.type ?? 'attachment'}]`;
  if (attachments.length > 1) return `[${attachments.length} attachments]`;

  return '';
}

function normaliseAttachment(raw: MetaRawAttachment): MetaAttachment {
  const type = raw?.type && ATTACHMENT_TYPES.has(raw.type) ? raw.type : 'unsupported';

  return {
    type: type as MetaAttachment['type'],
    url: raw?.payload?.url ?? null,
    title: raw?.payload?.title ?? null,
  };
}

function readReceipt(event: MetaMessagingEvent, platform: MetaPlatform): NormalisedReceipt | null {
  const delivery = event.delivery;
  const read = event.read;
  const source = delivery ?? read;
  if (!source) return null;

  return {
    platform,
    kind: delivery ? 'delivered' : 'read',
    mids: (source.mids ?? []).filter((mid): mid is string => typeof mid === 'string'),
    watermark: source.watermark ? fromEpoch(source.watermark) : null,
  };
}

/**
 * Comments, from either platform's very different change shape.
 *
 * Facebook sends `field: "feed"` with an `item` discriminator, because the same
 * field also carries likes, shares and post edits. Instagram sends
 * `field: "comments"` with the comment as the whole value.
 */
function readComment(
  change: MetaChange,
  platform: MetaPlatform,
  connection: MetaConnection | null,
  entry: MetaEntry,
): NormalisedComment | null {
  const value = change?.value;
  if (!isObject(value)) return null;

  if (platform === 'facebook') {
    if (change.field !== 'feed' || value.item !== 'comment') return null;
    if (!value.comment_id) return null;

    const verb = value.verb ?? 'add';
    if (!OPENING_VERBS.has(verb)) return null;

    // A comment left by the page itself is our own agent's public reply coming
    // back to us; filing it as a customer message would duplicate it.
    if (value.from?.id && entry.id && value.from.id === entry.id) return null;

    return {
      platform,
      connection,
      commentId: value.comment_id,
      // Meta sets parent_id to the post for a top-level comment and to the
      // parent comment for a reply, so "is this a reply?" is exactly "is the
      // parent something other than the post?".
      parentCommentId:
        value.parent_id && value.parent_id !== value.post_id ? value.parent_id : null,
      postId: value.post_id ?? null,
      from: value.from?.id ?? '',
      fromName: value.from?.name ?? null,
      text: (value.message ?? '').trim(),
      createdAt: fromEpoch(value.created_time),
      verb,
      raw: value as unknown as Record<string, unknown>,
    };
  }

  if (change.field !== 'comments') return null;

  const commentId = value.id;
  if (!commentId) return null;
  if (value.from?.id && entry.id && value.from.id === entry.id) return null;

  const mediaId = value.media?.id ?? null;

  return {
    platform,
    connection,
    commentId,
    // Same guard as Facebook's above, for the same reason: `ingestMetaComment`
    // keys the ticket on `parent_id ?? comment_id`, so a `parent_id` naming the
    // *media* rather than a parent comment would collapse every top-level
    // comment on that post onto one ticket.
    //
    // **Settled by a real payload on 2026-08-30**, having been an open question
    // for as long as this branch had never run: a top-level comment carries no
    // `parent_id` at all. Meta's own sample does carry one alongside a distinct
    // `media.id`, which is what made the shape look ambiguous — the sample is
    // describing a reply. The guard stays, because it costs nothing and a
    // reply's parent is always a comment, so it cannot discard a real thread
    // link; but it is now belt over braces rather than the load-bearing part.
    parentCommentId: value.parent_id && value.parent_id !== mediaId ? value.parent_id : null,
    postId: mediaId,
    from: value.from?.id ?? '',
    fromName: value.from?.username ?? value.from?.name ?? null,
    text: (value.text ?? '').trim(),
    createdAt: fromEpoch(value.created_time),
    verb: 'add',
    raw: value as unknown as Record<string, unknown>,
  };
}

/**
 * Meta sends seconds for comments and milliseconds for messaging events, with
 * no marker distinguishing them. Anything below this threshold is seconds — it
 * is the year 2001 in milliseconds and the year 33658 in seconds, so no real
 * timestamp is ambiguous.
 */
const MILLISECOND_THRESHOLD = 1_000_000_000_000;

function fromEpoch(value: number | undefined): Date {
  if (!value || !Number.isFinite(value)) return new Date();
  const ms = value < MILLISECOND_THRESHOLD ? value * 1000 : value;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
