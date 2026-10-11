'use client';

import { useState } from 'react';
import { confirmCategory, rejectCategory } from '../../../category-actions';

/**
 * Confirm or reject, one click each.
 *
 * The same two server actions the ticket sidebar calls, deliberately: a queue
 * that wrote its own version of "confirm" would be a second place for the rule
 * about keeping `confidence` and `rule_key` to be forgotten.
 *
 * The row disappears on success because `confirmCategory` and `rejectCategory`
 * both revalidate this path — nothing here has to know that, which is why the
 * revalidation lives in the shared `refresh()` rather than in each action.
 */
export function ReviewControls({
  conversationId,
  categoryId,
  label,
}: {
  conversationId: string;
  categoryId: string;
  label: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(action: typeof confirmCategory) {
    setBusy(true);
    setError(null);
    const formData = new FormData();
    formData.set('conversationId', conversationId);
    formData.set('categoryId', categoryId);
    const result = await action({ error: null }, formData);
    setBusy(false);
    if (result.error) setError(result.error);
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={busy}
        aria-label={`Confirm ${label}`}
        onClick={() => void decide(confirmCategory)}
        className="rounded border border-[var(--border)] px-2 py-1 text-xs hover:bg-[var(--muted)] disabled:opacity-50"
      >
        Confirm
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Reject ${label}`}
        onClick={() => void decide(rejectCategory)}
        className="rounded border border-[var(--border)] px-2 py-1 text-xs opacity-70 hover:bg-[var(--muted)] hover:opacity-100 disabled:opacity-50"
      >
        Reject
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
