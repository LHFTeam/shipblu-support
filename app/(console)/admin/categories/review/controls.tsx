'use client';

import { useState } from 'react';
import { Button, ErrorText } from '@/components/ui';
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
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        aria-label={`Confirm ${label}`}
        onClick={() => void decide(confirmCategory)}
      >
        Confirm
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        aria-label={`Reject ${label}`}
        onClick={() => void decide(rejectCategory)}
      >
        Reject
      </Button>
      {error ? <ErrorText inline>{error}</ErrorText> : null}
    </div>
  );
}
