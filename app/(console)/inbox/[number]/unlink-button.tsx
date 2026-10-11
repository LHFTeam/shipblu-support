'use client';

import { useConfirmClick } from '@/components/confirm-submit';
import { type LinkAction, useFieldAction } from './use-field-action';

/**
 * Two-click removal. Not a `ConfirmSubmit`, because there is no form here — the
 * write goes through `useFieldAction` like the sidebar's other controls — but
 * the same click rule, so a double-click arms it and stops (§6.90).
 */
export function UnlinkButton({
  action,
  fields,
  label,
}: {
  action: LinkAction;
  fields: Record<string, string>;
  label: string;
}) {
  const { pending: busy, run } = useFieldAction(action, { rereadOnRefusal: true });
  const { armed, disarm, onClick, onKeyDown } = useConfirmClick(() => run(fields));

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onBlur={disarm}
      className="shrink-0 rounded px-1 text-xs opacity-50 hover:opacity-100"
    >
      {armed ? 'Sure?' : '×'}
    </button>
  );
}
