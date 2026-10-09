'use client';

import { startTransition, useActionState, useEffect, useEffectEvent, type FormEvent } from 'react';
import { unstable_rethrow, useRouter } from 'next/navigation';
import type { ActionState } from '@/lib/http/action-state';

/**
 * Said when the action never answered: the connection dropped, the server
 * failed, a deploy cut the request off. Whether the write landed is unknown,
 * so the sentence says so rather than inviting a blind retry, and points at the
 * page the hook has just re-read. A form whose retry reaches a customer says
 * where to look instead, and one whose `error` is a key says it in its own
 * words — `lost` below.
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
 * across the console's forms, then the help centre's and the sign-in pages';
 * `docs/PROJECT-STATE.md` §6.80.
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
 *   without a nonce is given a fresh one, so the key still moves and
 *   `onSuccess` still runs. Anything else keeps the nonce it found.
 * - **An action that throws becomes a refusal.** Without this, `useActionState`
 *   rethrows it while rendering, the console falls through to `global-error`,
 *   and the draft goes with it. Next's own redirect and not-found go through
 *   untouched: `requireAgent()` redirects an ended session, which rejects the
 *   call while Next navigates, and nothing was written.
 *
 * `form` is spread onto the `<form>` — `<form {...form} key={key}>` — rather
 * than wired as two props, because a form given only `action` still submits:
 * through React's own path, reset and all, which is the bug this exists to
 * close. The `form-reset` repo rule refuses a form anywhere under `app/` that
 * does that.
 *
 * `onSuccess` is what a form does next: an admin editor closes, a composer on a
 * phone puts itself away. It runs once per success, after the commit that
 * delivers the answer, and not at all if that commit unmounts the form — a row
 * the success removed takes its form with it. Nothing here re-reads the page:
 * an action that revalidates has the re-rendered page sent back with its
 * answer, and a `router.refresh()` after it was a second full render (§6.87).
 * It is read as an effect event, so an inline function is fine, and keyed on
 * the nonce, which only a success moves. A form whose `error` is a key takes
 * no `onSuccess`: no help-centre action answers `ok: true`, so it would never
 * run.
 */
export function useActionForm<State extends ActionState>(
  action: (state: Awaited<State>, formData: FormData) => Promise<State>,
  initial: Awaited<State>,
  ...[options]: Options<Awaited<State>>
): { state: Awaited<State>; key: number; form: FormHandlers; pending: boolean } {
  const router = useRouter();
  const lost: string = options?.lost ?? LOST;
  const succeeded = useEffectEvent(() => options?.onSuccess?.());

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
      // If it did land, this is what puts it on the page the error points at:
      // an action that never answered sent no page back.
      router.refresh();
      return { error: lost, nonce: previous.nonce } as Awaited<State>;
    }
  }

  const [state, dispatch, pending] = useActionState(answer, initial);

  useEffect(() => {
    if (state.ok) succeeded();
  }, [state.ok, state.nonce]);

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

/**
 * What a thrown action answers with. A form whose `error` is a sentence may
 * leave it to `LOST`. One whose `error` is a key its page translates — the help
 * centre's `StringKey` — must name its own: `t()` looks the English sentence up
 * as a key, finds nothing, and `ErrorText` renders nothing, so the customer is
 * not told their reply may not have gone. Required by type rather than by
 * convention, because forgetting it fails silently.
 */
type Options<State extends ActionState> =
  string extends NonNullable<State['error']>
    ? [options?: { lost?: string; onSuccess?: () => void }]
    : [options: { lost: NonNullable<State['error']>; onSuccess?: never }];

/** Spread onto the `<form>`; a component rendering it for a parent takes this. */
export type FormHandlers = {
  action: (formData: FormData) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};
