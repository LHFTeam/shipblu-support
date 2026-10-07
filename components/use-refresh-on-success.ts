'use client';

import { useEffect, useEffectEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionState } from '@/lib/http/action-state';

/**
 * Re-reads the server components after a successful action, so the page shows
 * what was just written: the timeline the message, the list the row.
 *
 * It fires on each new answer that is a success — `ok: true`, what `ok()`
 * returns. Every answer `useActionState` hands back is a new object, so two
 * saves in a row both fire without leaning on the action to have set a nonce,
 * which a bare `useActionState` does not supply. A refusal never fires it.
 *
 * `onSuccess` is what a form does next: an admin editor closes, a composer on a
 * phone puts itself away so the agent lands on the timeline rather than an
 * empty box. It is read as an effect event rather than listed as a dependency.
 * As a dependency, a new closure each render re-ran this effect after the
 * render its own refresh caused, so every caller had to pass a stable function.
 * The admin editors pass an inline one, and got away with it only because their
 * callback unmounts the form that calls this.
 *
 * Written once; the admin editors and the inbox composers each kept a copy.
 */
export function useRefreshOnSuccess(state: ActionState, onSuccess?: () => void) {
  const router = useRouter();
  const succeeded = useEffectEvent(() => onSuccess?.());
  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
    succeeded();
  }, [state, router]);
}
