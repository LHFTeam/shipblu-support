'use client';

import { startTransition, useActionState, type FormEvent } from 'react';
import { unstable_rethrow, useRouter } from 'next/navigation';
import type { ActionState } from '@/lib/http/action-state';

/**
 * Said when the action never answered: the connection dropped, the server
 * failed, a deploy cut the request off. Whether the write landed is unknown,
 * so the sentence says so rather than inviting a blind retry, and points at the
 * page the hook has just re-read. A form whose retry reaches a customer says
 * where to look instead — `lost` below.
 */
const LOST =
  'No answer came back, so this may or may not have gone through. Check the page before trying again.';

/**
 * `useActionState` for a form, without the reset React performs on a refusal.
 *
 * `<form action={fn}>` makes React 19 queue a native `form.reset()` before it
 * calls `fn` and run it once the action settles, whatever the action answered.
 * A success hides that, because the form clears anyway; a refusal does not. The
 * agent's reply goes back to empty at the moment they are about to correct one
 * word of it. And the reset is the browser's, so it knows nothing of React
 * state: a controlled `<select>` lands on the option the server rendered as
 * selected, or on its first enabled option if it was mounted in the browser,
 * and a controlled checkbox on what it showed at mount. The component still
 * holds the agent's choice, so the screen drawn from it says one thing and the
 * control, which is what gets submitted, says another. Measured in Chromium
 * across the console's forms; `docs/PROJECT-STATE.md` §6.80.
 *
 * So the form submits from `onSubmit`, which cancels the native submission and
 * starts the action in a transition of its own. React then takes the path it
 * keeps for exactly that: it marks the form pending — `SubmitButton` reads that
 * through `useFormStatus` — and queues no reset. `action` stays on the form as
 * well, for a submission made before hydration: React captures it and replays
 * it once it loads, where a form with no `action` would send its fields to the
 * page's own URL as a query string. That one replayed submission takes React's
 * own path, reset included.
 *
 * Two things the action's answer is not trusted with:
 * - **Only a success moves `key`.** The form remounts on `key` to clear itself
 *   after a success (§6.58), and a refusal carries no nonce. Taken as it came
 *   back, it turned the key from the last success's back to 0 and the remount
 *   wiped the form just as the reset did, on the second send rather than the
 *   first. A success is what `ok()` answers, `ok: true`; one that arrives
 *   without a nonce is given a fresh one, so the key still moves. Anything
 *   else keeps the nonce it found.
 * - **An action that throws becomes a refusal.** Without this, `useActionState`
 *   rethrows it while rendering, the console falls through to `global-error`,
 *   and the draft goes with it. Next's own redirect and not-found go through
 *   untouched: `requireAgent()` redirects an ended session, which rejects the
 *   call while Next navigates, and nothing was written.
 *
 * `form` is spread onto the `<form>` — `<form {...form} key={key}>` — rather
 * than wired as two props, because a form given only `action` still submits:
 * through React's own path, reset and all, which is the bug this exists to
 * close. The `form-reset` repo rule refuses a console form that does that.
 */
export function useActionForm<State extends ActionState>(
  action: (state: Awaited<State>, formData: FormData) => Promise<State>,
  initial: Awaited<State>,
  { lost = LOST }: { lost?: string } = {},
): { state: Awaited<State>; key: number; form: FormHandlers; pending: boolean } {
  const router = useRouter();

  async function answer(previous: Awaited<State>, formData: FormData) {
    try {
      const result = await action(previous, formData);
      return (
        result.ok
          ? { ...result, nonce: result.nonce ?? Date.now() }
          : { ...result, nonce: previous.nonce }
      ) as Awaited<State>;
    } catch (error) {
      unstable_rethrow(error);
      // If it did land, this is what puts it on the page the error points at.
      router.refresh();
      return { error: lost, nonce: previous.nonce } as Awaited<State>;
    }
  }

  const [state, dispatch, pending] = useActionState(answer, initial);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // With the submitter, so a named submit button still says which one was
    // pressed. A button's own `formAction` is not honoured; no console form
    // has one.
    const formData = new FormData(
      event.currentTarget,
      (event.nativeEvent as SubmitEvent).submitter,
    );
    startTransition(() => dispatch(formData));
  }

  return { state, key: state.nonce ?? 0, form: { action: dispatch, onSubmit }, pending };
}

/** Spread onto the `<form>`; a component rendering it for a parent takes this. */
export type FormHandlers = {
  action: (formData: FormData) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};
