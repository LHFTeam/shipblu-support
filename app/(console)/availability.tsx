'use client';

import { useActionState } from 'react';
import { setAcceptingTickets } from './availability-actions';

/**
 * The agent's own "route work to me" switch, in the console header.
 *
 * Here rather than buried in a settings page because it is a thing somebody
 * changes several times a day — going into a meeting, coming out of one — and a
 * switch you have to navigate to is a switch that stays wrong.
 *
 * It is deliberately *not* a presence control. Whether an agent is connected is
 * observed from their open event stream and cannot be lied about; this says
 * something different and narrower — "I am here, don't give me anything new".
 * Their existing tickets stay theirs either way, which is what the label has to
 * make obvious, or the first person to click it will do so expecting their queue
 * to be handed to somebody else.
 */
export function AvailabilitySwitch({ accepting }: { accepting: boolean }) {
  const [state, action, pending] = useActionState(setAcceptingTickets, { error: null });
  const on = state.accepting ?? accepting;

  return (
    <form action={action}>
      <input type="hidden" name="accepting" value={on ? 'false' : 'true'} />
      <button
        type="submit"
        disabled={pending}
        title={
          on
            ? 'New tickets can be assigned to you. Click to stop.'
            : 'New tickets are not being assigned to you. Your existing ones are unaffected.'
        }
        className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] disabled:opacity-50"
      >
        <span
          aria-hidden
          className={`size-2 rounded-full ${on ? 'bg-emerald-500' : 'bg-amber-500'}`}
        />
        {on ? 'Accepting' : 'Not accepting'}
      </button>
    </form>
  );
}
