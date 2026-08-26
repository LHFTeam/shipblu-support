import type { SessionAgent } from '@/lib/auth/session';
import {
  canSeeChannel,
  CONVERSATION_CHANNELS,
  isRestrictedChannel,
  type ConversationChannel,
} from '@/lib/tickets/channel-policy';

/**
 * Names shared by the SQL producer and the LISTEN consumers.
 *
 * Queue topics are split by channel so the high-volume customer bot never
 * reaches listeners for the working queue. Conversation topics go one step
 * further: a ticket view and a public widget listen only to the UUID they have
 * already been authorised to read, instead of receiving every change in the
 * installation and deciding afterwards whether to query.
 */
const QUEUE_PREFIX = 'conversation_queue_';
const CONVERSATION_PREFIX = 'conversation_';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type QueueChannel = ConversationChannel | 'all';

export function parseQueueChannel(value: string | null): QueueChannel | null {
  if (!value || value === 'all') return 'all';
  return (CONVERSATION_CHANNELS as readonly string[]).includes(value)
    ? (value as ConversationChannel)
    : null;
}

export function queueTopic(channel: ConversationChannel): string {
  return `${QUEUE_PREFIX}${channel}`;
}

/**
 * Topics backing the exact queue an agent asked to see.
 *
 * `all` is the working queue, so restricted channels stay opt-in even for an
 * administrator who may open them. An explicit restricted channel is accepted
 * only when the agent has its permission. `null` means the request is forbidden.
 */
export function queueTopicsForAgent(agent: SessionAgent, requested: QueueChannel): string[] | null {
  if (requested === 'all') {
    return CONVERSATION_CHANNELS.filter((channel) => !isRestrictedChannel(channel)).map(queueTopic);
  }

  if (!canSeeChannel(agent, requested)) return null;
  return [queueTopic(requested)];
}

/** A valid PostgreSQL LISTEN identifier derived only from a UUID. */
export function conversationTopic(conversationId: string): string | null {
  if (!UUID_PATTERN.test(conversationId)) return null;
  return `${CONVERSATION_PREFIX}${conversationId.replaceAll('-', '').toLowerCase()}`;
}
