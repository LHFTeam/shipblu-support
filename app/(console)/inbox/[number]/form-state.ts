'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionState } from '../../action-state';

export const INITIAL: ActionState = { error: null };

/**
 * Re-reads the server components after a successful action, so the timeline
 * shows the message that was just written.
 *
 * The fields clear by remounting the form on `state.nonce` rather than by
 * resetting controlled state — the inputs stay uncontrolled, which is also what
 * lets the browser keep a draft through an accidental tab switch.
 *
 * `onSent` puts the composer away on a phone once the message is gone, which is
 * what makes the message land where the agent is looking: the timeline is the
 * thing they want to see after sending, not an empty box. It must be a stable
 * reference — it is a dependency here, and a new closure each render would run
 * this effect against its own refresh.
 */
export function useRefreshOnSuccess(state: ActionState, onSent?: () => void) {
  const router = useRouter();
  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
    onSent?.();
  }, [state, router, onSent]);
}
