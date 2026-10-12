'use client';

import { useConfirmClick } from '@/components/confirm-submit';
import { XIcon } from '@/components/icons';
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
      // Armed, it says so in words as well as in red: the colour alone is not
      // the warning.
      className={`inline-flex min-h-6 shrink-0 items-center rounded-md px-1 text-xs transition-colors disabled:opacity-50 ${
        armed
          ? 'bg-(--color-feedback-danger-bg) font-medium text-(--color-feedback-danger-fg)'
          : 'text-(--color-text-tertiary) hover:bg-(--color-background-hover) hover:text-(--color-text-primary)'
      }`}
    >
      {armed ? 'Sure?' : <XIcon size={14} />}
    </button>
  );
}
