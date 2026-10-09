'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type LinkAction = (
  state: { error: string | null },
  formData: FormData,
) => Promise<{ error: string | null }>;

/**
 * One sidebar control's write: build the form, call the action, show what it
 * refused.
 *
 * A success re-reads nothing. Every action behind these controls revalidates
 * the ticket before it succeeds, and Next sends the re-rendered page back with
 * the action's answer, so the timeline already holds the audit entry the action
 * wrote; a `router.refresh()` after it was a second render of the whole ticket
 * page (§6.89).
 *
 * Nine controls on the ticket page spelled this out by hand, and they did not
 * all do it the same way, so the differences are options rather than lost:
 *
 * - `rereadOnRefusal` re-reads the page after a refusal, for a control that
 *   shows no error and whose refusal means the screen is out of date: the
 *   ticket is no longer this agent's to see, the category is gone, the
 *   permission was revoked. Those refusals return before anything is written,
 *   so they revalidate nothing, and without the re-read the control would just
 *   do nothing. Acting on what another agent already removed or decided is not
 *   a refusal: those actions succeed, and revalidate.
 * - `clearError: false` keeps the last refusal on screen while a retry is
 *   pending, which is what the link inputs have always done.
 *
 * `run` hands the result back, so a control can do its own follow-up: revert a
 * choice it showed optimistically, clear an input, disarm a button.
 */
export function useFieldAction(
  action: LinkAction,
  {
    rereadOnRefusal = false,
    clearError = true,
  }: { rereadOnRefusal?: boolean; clearError?: boolean } = {},
) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fields: Record<string, string | string[]>) {
    setPending(true);
    if (clearError) setError(null);

    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      // `append`, so a multi-select arrives as the several values it is rather
      // than one comma-joined string the action would have to guess how to split.
      if (Array.isArray(value)) for (const entry of value) formData.append(key, entry);
      else formData.set(key, value);
    }

    const result = await action({ error: null }, formData);
    setPending(false);
    setError(result.error);
    if (result.error && rereadOnRefusal) router.refresh();

    return result;
  }

  return { pending, error, run };
}
