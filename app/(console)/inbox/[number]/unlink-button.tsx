'use client';

import { useState } from 'react';
import { type LinkAction, useFieldAction } from './use-field-action';

/**
 * Two-click removal, inline rather than importing `DangerAction` from the admin
 * forms. Reaching into admin internals from the inbox would couple two areas
 * that have stayed apart; promoting that component into `components/ui.tsx` is
 * the better move and a wider change than this feature should carry.
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
  const [armed, setArmed] = useState(false);
  const { pending: busy, run } = useFieldAction(action, { refresh: 'always' });

  async function remove() {
    await run(fields);
    setArmed(false);
  }

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      onClick={() => (armed ? void remove() : setArmed(true))}
      onBlur={() => setArmed(false)}
      className="shrink-0 rounded px-1 text-xs opacity-50 hover:opacity-100"
    >
      {armed ? 'Sure?' : '\u00d7'}
    </button>
  );
}
