/**
 * Messenger and Instagram messaging windows.
 *
 * Two windows, not one, and the difference matters to an agent mid-reply:
 *
 *   0–24 hours   a standard reply sends, no strings attached.
 *   24h–7 days   only with the HUMAN_AGENT tag, which is exactly what a support
 *                team is for — a person answering a person's question.
 *   after 7 days nothing sends at all.
 *
 * WhatsApp's equivalent falls back to a paid approved template; these platforms
 * have no such escape, so once the seven days are gone the conversation can
 * only be continued by the customer writing again.
 */

export type MetaWindowState = {
  /** A plain reply will send. */
  isOpen: boolean;
  /** A reply will send if it is tagged as a human agent response. */
  needsHumanAgentTag: boolean;
  /** Nothing will send. */
  isClosed: boolean;
  standardExpiresAt: Date | null;
  humanAgentExpiresAt: Date | null;
  remainingMs: number;
  reason: 'open' | 'human_agent_only' | 'expired' | 'never_opened';
};

export const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Only the customer's own last message opens either window. An agent reply does
 * not extend it — the same rule as WhatsApp, and the same expensive misreading
 * to avoid.
 */
export function metaWindowState(
  lastCustomerMessageAt: Date | null,
  now: Date = new Date(),
): MetaWindowState {
  if (!lastCustomerMessageAt) {
    return {
      isOpen: false,
      needsHumanAgentTag: false,
      isClosed: true,
      standardExpiresAt: null,
      humanAgentExpiresAt: null,
      remainingMs: 0,
      reason: 'never_opened',
    };
  }

  const base = lastCustomerMessageAt.getTime();
  const standardExpiresAt = new Date(base + STANDARD_WINDOW_MS);
  const humanAgentExpiresAt = new Date(base + HUMAN_AGENT_WINDOW_MS);

  if (now.getTime() < standardExpiresAt.getTime()) {
    return {
      isOpen: true,
      needsHumanAgentTag: false,
      isClosed: false,
      standardExpiresAt,
      humanAgentExpiresAt,
      remainingMs: standardExpiresAt.getTime() - now.getTime(),
      reason: 'open',
    };
  }

  if (now.getTime() < humanAgentExpiresAt.getTime()) {
    return {
      isOpen: false,
      needsHumanAgentTag: true,
      isClosed: false,
      standardExpiresAt,
      humanAgentExpiresAt,
      remainingMs: humanAgentExpiresAt.getTime() - now.getTime(),
      reason: 'human_agent_only',
    };
  }

  return {
    isOpen: false,
    needsHumanAgentTag: false,
    isClosed: true,
    standardExpiresAt,
    humanAgentExpiresAt,
    remainingMs: 0,
    reason: 'expired',
  };
}

/** What the send path should put on the request. */
export function messagingTag(state: MetaWindowState): 'RESPONSE' | 'HUMAN_AGENT' | null {
  if (state.isOpen) return 'RESPONSE';
  if (state.needsHumanAgentTag) return 'HUMAN_AGENT';
  return null;
}

/** One line for the composer, in the agent's terms rather than Meta's. */
export function describeWindow(state: MetaWindowState): string {
  switch (state.reason) {
    case 'open':
      return `${formatRemaining(state.remainingMs)} to reply freely`;
    case 'human_agent_only':
      return `Outside the 24-hour window — replies go out tagged as a human agent (${formatRemaining(
        state.remainingMs,
      )})`;
    case 'expired':
      return 'The 7-day window has closed. Only the customer can reopen this conversation.';
    case 'never_opened':
      return 'No customer message yet, so nothing can be sent.';
  }
}

export function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return 'closed';

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m left`;
  return 'under a minute left';
}
