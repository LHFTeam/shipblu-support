'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type LinkAction = (
  state: { error: string | null },
  formData: FormData,
) => Promise<{ error: string | null }>;

/**
 * One sidebar control's write: build the form, call the action, then re-read
 * the server components so the timeline picks up the audit entry the action
 * just wrote.
 *
 * Nine controls on the ticket page spelled this out by hand, and they did not
 * all do it the same way, so the differences are options rather than lost:
 *
 * - `refresh: 'on-success'` (the default) shows a refusal and re-reads only on
 *   success. `'always'` re-reads either way, for a control whose refusal is
 *   itself written to the row, or one that shows no error at all.
 * - `clearError: false` keeps the last refusal on screen while a retry is
 *   pending, which is what the link inputs have always done.
 *
 * `run` hands the result back, so a control can do its own follow-up: revert a
 * choice it showed optimistically, clear an input, disarm a button.
 */
export function useFieldAction(
  action: LinkAction,
  {
    refresh = 'on-success',
    clearError = true,
  }: { refresh?: 'on-success' | 'always'; clearError?: boolean } = {},
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

    if (refresh === 'always') {
      setError(result.error);
      router.refresh();
    } else if (result.error) {
      setError(result.error);
    } else {
      setError(null);
      router.refresh();
    }

    return result;
  }

  return { pending, error, run };
}
