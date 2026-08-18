/**
 * WhatsApp's 24-hour customer service window.
 *
 * Meta only allows free-form messages within 24 hours of the customer's *last*
 * message. Outside that window nothing but an approved template will send, and
 * the API rejects the attempt rather than queuing it.
 *
 * This is the rule agents collide with most often, so the console needs to know
 * the state *before* the agent writes a reply — discovering it at send time
 * means losing what they typed. Hence a pure function the UI and the send path
 * both call.
 */

export type WindowState = {
  /** True when a free-form (non-template) message may be sent. */
  isOpen: boolean;
  /** When the window closes. Null when no customer message has ever arrived. */
  expiresAt: Date | null;
  /** Milliseconds remaining, 0 when closed. Drives the countdown in the UI. */
  remainingMs: number;
  reason: 'open' | 'expired' | 'never_opened';
};

export const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * `lastCustomerMessageAt` is deliberately the only input that can open the
 * window. Agent replies and template sends do not extend it — a common and
 * expensive misreading of Meta's rules, since it would let an agent believe
 * they can keep replying freely after a template.
 */
export function windowState(
  lastCustomerMessageAt: Date | null,
  now: Date = new Date(),
): WindowState {
  if (!lastCustomerMessageAt) {
    return { isOpen: false, expiresAt: null, remainingMs: 0, reason: 'never_opened' };
  }

  const expiresAt = new Date(lastCustomerMessageAt.getTime() + WINDOW_DURATION_MS);
  const remainingMs = expiresAt.getTime() - now.getTime();

  if (remainingMs <= 0) {
    return { isOpen: false, expiresAt, remainingMs: 0, reason: 'expired' };
  }

  return { isOpen: true, expiresAt, remainingMs, reason: 'open' };
}

/** What the composer is allowed to send right now. */
export function allowedSendKind(state: WindowState): 'free_form' | 'template_only' {
  return state.isOpen ? 'free_form' : 'template_only';
}

/** Human countdown for the composer, e.g. "3h 12m left". */
export function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return 'closed';

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m left`;
  return 'under a minute left';
}
