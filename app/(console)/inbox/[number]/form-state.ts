'use client';

import { useEffect, useState, type FormEvent } from 'react';
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

/**
 * Said when the action never answered — the connection dropped, the server
 * failed, a deploy cut the request off. Whether the write landed is unknown,
 * so the sentence sends the agent to the timeline rather than to the button.
 */
const LOST =
  'No answer came back, so this may or may not have been sent. Check the timeline before sending it again.';

/**
 * Submits a form to an action without letting React reset it.
 *
 * `<form action={fn}>` makes React 19 reset the form after every action, a
 * refused one included (`docs/PROJECT-STATE.md` §6.79). The nonce key hides
 * that on success; on a refusal it wipes what the agent typed, and a controlled
 * select falls back to its first enabled option while its state says otherwise.
 * Submitting by hand keeps a refused form exactly as the agent left it, and a
 * success still clears it through `key={state.nonce}` like every other form.
 *
 * It also owns the one case a hand-rolled submit forgets: an action that throws
 * instead of answering. Without the `finally` the button stays on "Sending…"
 * for good, and without the `catch` the agent is told nothing.
 */
export function useSubmitWithoutReset(
  action: (state: ActionState, formData: FormData) => Promise<ActionState>,
  onSent?: () => void,
) {
  const router = useRouter();
  const [state, setState] = useState<ActionState>(INITIAL);
  const [busy, setBusy] = useState(false);
  useRefreshOnSuccess(state, onSent);

  async function send(formData: FormData) {
    setBusy(true);
    try {
      setState(await action(INITIAL, formData));
    } catch {
      setState({ error: LOST });
      // If it did land, this is what puts it on the timeline the error points at.
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(new FormData(event.currentTarget));
  }

  return { state, busy, onSubmit };
}
