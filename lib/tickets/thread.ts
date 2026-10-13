import {
  isPrivateReplyMessage,
  isPublicMetaMessage,
  type MetaMessageMeta,
} from '@/lib/meta/visibility';
import { lostReceiptNote } from '@/lib/whatsapp/receipts';

/**
 * How the ticket thread reads a message: whose voice it is, and what became
 * of it once sent. The decisions behind the console's bubbles, kept out of
 * the component so they can be tested without rendering one.
 *
 * Client-safe: the thread is a client component, so this imports nothing from
 * `db/` and takes the message as the shape it reads rather than the row —
 * `ConversationDetail` is built on the database and may not be reached from
 * here by value. The tones are spelled out rather than imported from the
 * Badge, so `lib/` does not reach into `components/`, as `inbox-badges` does;
 * each is one of its tones, which the thread checks when it hands them over.
 */

/** The fields of a thread message these decisions read. */
export type ThreadMessage = {
  direction: 'inbound' | 'outbound';
  kind: 'reply' | 'note' | 'system' | 'forward';
  authorName: string | null;
  authorIsAgent: boolean;
  deliveryStatus: string;
  deliveryError: string | null;
  meta: Record<string, unknown> | null;
};

/** What the thread reads off a message's `meta`, over the Meta fields `visibility` owns. */
export type MessageMeta = MetaMessageMeta & {
  echo?: boolean;
  echoSource?: string;
  media?: { downloaded?: boolean; error?: string };
};

/**
 * Who a message is from, in the thread's terms: which side it sits on, what
 * the bubble is, and the face and words beside it.
 *
 * The sides are the viewer's. Everything the team's side wrote — an agent, the
 * customer bot, an automation, the business on its own phone — is `out`,
 * because the bot is our half of the conversation, and the customer reading a
 * bot's answer as one of ours is exactly what happened.
 */
export type Voice = {
  from: 'in' | 'out';
  kind: 'message' | 'note' | 'bot';
  author: string;
  avatar: 'contact' | 'agent' | 'bot' | 'business-app';
  badges: { tone: 'note' | 'automated' | 'public' | 'private'; label: string }[];
};

export function voiceOf(message: ThreadMessage, meta: MessageMeta): Voice {
  const isInbound = message.direction === 'inbound';
  const isNote = message.kind === 'note';
  const businessApp = meta.echo === true && meta.echoSource === 'business_app';

  /*
    An echo has no author on either side: no agent wrote it and the customer
    did not send it. "Automation" would be technically true and useless — it
    was the customer bot, or the business typing on the WhatsApp Business app
    of a number connected through coexistence, and saying which one matters
    most. The bot's echoes predate `echoSource`, so its absence is the bot.
  */
  const author =
    message.authorName ??
    (meta.echo
      ? businessApp
        ? 'WhatsApp Business app'
        : 'Customer bot'
      : isInbound
        ? 'Customer'
        : 'Automation');

  // A person typed the business-app echo, on the phone; everything else on
  // our side with no agent behind it was written by a machine, and says so.
  const machine = !isInbound && !isNote && !message.authorIsAgent && !businessApp;

  const badges: Voice['badges'] = [];
  if (isNote) badges.push({ tone: 'note', label: 'Private note' });
  if (machine) badges.push({ tone: 'automated', label: 'Automated' });
  // Whether a reply was public is the thing an agent most needs to be sure of
  // on a social ticket, so it is stated rather than implied by which side the
  // bubble is on.
  if (isPublicMetaMessage(meta)) {
    badges.push({ tone: 'public', label: isInbound ? 'Public comment' : 'Posted publicly' });
  }
  if (isPrivateReplyMessage(meta, message.direction)) {
    badges.push({ tone: 'private', label: 'Sent privately' });
  }
  if (!isInbound && !isNote && meta.metaKind === 'direct_message') {
    badges.push({ tone: 'private', label: 'Direct message' });
  }

  return {
    // A note is the team's working, whichever way the row was filed.
    from: isInbound && !isNote ? 'in' : 'out',
    kind: isNote ? 'note' : machine ? 'bot' : 'message',
    author,
    avatar: message.authorIsAgent
      ? 'agent'
      : isNote
        ? 'bot'
        : isInbound
          ? 'contact'
          : businessApp
            ? 'business-app'
            : 'bot',
    badges,
  };
}

export type Delivery = {
  receipt?: 'sending' | 'sent' | 'delivered' | 'read';
  error?: string;
  /**
   * A line under the bubble where no receipt will do: `warning` for a send
   * whose outcome will never be known, `muted` for a status the thread has no
   * word for and quotes instead.
   */
  note?: { text: string; tone: 'warning' | 'muted' };
};

/**
 * What happened to something we sent, said under it.
 *
 * Every outbound row that is not a note, the bot's and the automations'
 * included: a reply that never reached the customer is the same failure
 * whoever wrote it.
 */
export function deliveryOf(message: ThreadMessage): Delivery {
  if (message.deliveryStatus === 'failed') {
    // A delivery error explains itself in paragraphs — what Meta said, and
    // what it means — so the bubble keeps its line breaks.
    return { error: `Not delivered — ${message.deliveryError ?? 'unknown error'}` };
  }

  // Replaces the bare "Sent" rather than sitting under it: that word alone is
  // what reads as confirmed, and here it never will be.
  const lostReceipt = lostReceiptNote(message);
  if (lostReceipt) {
    return { note: { text: lostReceipt, tone: 'warning' } };
  }

  switch (message.deliveryStatus) {
    case 'pending':
      return { receipt: 'sending' };
    case 'sent':
    case 'delivered':
    case 'read':
      return { receipt: message.deliveryStatus };
    // The mail server refused it: a failure, said as one.
    case 'bounced':
      return { error: 'Bounced' };
    default:
      return { note: { text: message.deliveryStatus, tone: 'muted' } };
  }
}
