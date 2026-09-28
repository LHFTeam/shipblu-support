'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type LinkAction = (
  state: { error: string | null },
  formData: FormData,
) => Promise<{ error: string | null }>;

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
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.set(key, value);
    await action({ error: null }, formData);
    setBusy(false);
    setArmed(false);
    router.refresh();
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
