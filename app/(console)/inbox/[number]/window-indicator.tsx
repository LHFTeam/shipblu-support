'use client';

import { Badge } from '@/components/ui';
import { useNow } from '@/components/use-now';
import { describeWindow, metaWindowState } from '@/lib/meta/window';
import type { ConversationDetail } from '@/lib/tickets/conversation';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';

/** The Messenger and Instagram windows, in the agent's terms. */
export function MetaWindowIndicator({
  lastCustomerMessageAt,
  thread,
}: {
  lastCustomerMessageAt: Date | string | null;
  thread: ConversationDetail['metaThread'];
}) {
  const now = useNow();

  // A thread that cannot be answered at all has no window worth counting, and
  // the countdown would contradict the composer standing beside it. Rendered
  // before the mount guard because this one is server-computed and does not
  // tick — there is no first frame to get wrong.
  if (thread && !thread.canSend) {
    return (
      <Badge tone="closed">
        {thread.reason === 'standby' ? 'Another app owns this inbox' : 'Cannot reply from here'}
      </Badge>
    );
  }

  if (!now) return null;

  const state = metaWindowState(
    lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null,
    now,
  );

  return (
    <Badge tone={state.isOpen ? 'open' : state.needsHumanAgentTag ? 'warning' : 'closed'}>
      {describeWindow(state)}
    </Badge>
  );
}

/**
 * Live countdown, ticking client-side.
 *
 * A window that silently expires while an agent is composing is the single
 * worst WhatsApp failure mode, so the number has to move rather than reflect
 * whenever the page last rendered.
 */
export function WindowIndicator({
  lastCustomerMessageAt,
}: {
  lastCustomerMessageAt: Date | string | null;
}) {
  const last = lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null;
  const now = useNow();

  // Null until mounted. Rendering nothing for that first pass is deliberate:
  // a countdown computed on the server would be wrong by the time it arrived.
  if (!now) return null;

  const state = windowState(last, now);

  return state.isOpen ? (
    <Badge tone={state.remainingMs < 2 * 60 * 60 * 1000 ? 'warning' : 'open'}>
      window {formatRemaining(state.remainingMs)}
    </Badge>
  ) : (
    <Badge tone="closed">window closed — template only</Badge>
  );
}

/**
 * The 24-hour window at a glance, so agents can triage by what is expiring.
 *
 * The inbox list's compact form of `WindowIndicator`, on the same clock: it
 * used to read `new Date()` during render, so a badge never moved while the
 * list stayed open, and the server and the browser could each pick a
 * different one for the same row.
 */
export function WhatsAppWindowBadge({
  lastCustomerMessageAt,
}: {
  lastCustomerMessageAt: Date | string | null;
}) {
  const now = useNow();
  if (!now) return null;

  const state = windowState(lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null, now);

  if (!state.isOpen) return <Badge tone="closed">window closed</Badge>;
  // Under two hours is when it starts mattering; above that it is just noise.
  if (state.remainingMs < 2 * 60 * 60 * 1000) {
    return <Badge tone="warning">{formatRemaining(state.remainingMs)}</Badge>;
  }
  return null;
}

/**
 * The Messenger and Instagram equivalent.
 *
 * Only shown once a reply needs the human-agent tag or has become impossible —
 * the first 24 hours are unremarkable and a badge on every row would say
 * nothing.
 */
export function MetaWindowBadge({
  lastCustomerMessageAt,
}: {
  lastCustomerMessageAt: Date | string | null;
}) {
  const now = useNow();
  if (!now) return null;

  const state = metaWindowState(
    lastCustomerMessageAt ? new Date(lastCustomerMessageAt) : null,
    now,
  );

  if (state.isClosed) return <Badge tone="closed">window closed</Badge>;
  if (state.needsHumanAgentTag) return <Badge tone="warning">outside 24h</Badge>;
  return null;
}
