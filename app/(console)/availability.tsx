'use client';

import { useActionState } from 'react';
import { InfoTip } from '@/components/tooltip';
import type { SessionAgent } from '@/lib/auth/session';
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
 * Their existing tickets stay theirs either way, which is what the explanation
 * has to make obvious, or the first person to click it will do so expecting
 * their queue to be handed to somebody else.
 *
 * When it is off, the line under it says how it got there. Three parties turn
 * it off — the agent, a supervisor and the idle timer — and only the last is
 * undone by the next keypress, so an agent who finds it off needs to know which
 * one it was before deciding whether to turn it back on. Colour is never the
 * only signal: the word changes with the track.
 */
export function AvailabilitySwitch({
  accepting,
  offReason,
  awayAfterMins,
}: {
  accepting: boolean;
  offReason: SessionAgent['acceptingOffReason'];
  awayAfterMins: number | null;
}) {
  const [state, action, pending] = useActionState(setAcceptingTickets, { error: null });
  const on = state.accepting ?? accepting;
  // Once this tab has toggled it, the reason is the agent's own, whatever the
  // render it started from said.
  const reason = state.accepting === undefined ? offReason : 'self';
  const line = on ? null : reasonLine(reason, awayAfterMins);

  return (
    <div className="flex items-center gap-1">
      <form action={action} className="flex flex-col items-start gap-px">
        <input type="hidden" name="accepting" value={on ? 'false' : 'true'} />
        {/* Drawn as a switch but announced as a plain button named by its state
            word, as before the restyle. A `role="switch"` takes its name from
            the label, and a label that flips to "Away" made it "Away, switch,
            off"; a constant hidden name instead would not match the word on
            screen, which is what a voice-control user says. So the track is
            styled from `data-on`, not `aria-checked`. */}
        <button
          type="submit"
          data-on={on}
          disabled={pending}
          className="group -m-1 inline-flex items-center gap-2 rounded-md p-1 text-xs whitespace-nowrap text-(--color-text-primary) disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span
            aria-hidden
            className="relative h-[18px] w-8 flex-none rounded-full bg-neutral-300 transition-colors group-data-[on=true]:bg-green-500 after:absolute after:start-0.5 after:top-0.5 after:size-3.5 after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgb(0_0_0/0.2)] after:transition-[inset-inline-start] group-data-[on=true]:after:start-4"
          />
          <span className="font-medium">{on ? 'Accepting tickets' : 'Away'}</span>
        </button>
        {line ? (
          <span className="hidden ps-10 text-2xs text-(--color-text-secondary) sm:block">
            {line}
          </span>
        ) : null}
      </form>
      {/* What was a `title` on the switch, beside it rather than in it: the
          tip is a button of its own, and a phone never shows a `title`. */}
      <InfoTip label="accepting tickets">
        {on
          ? 'New tickets can be assigned to you. Turn this off to stop; your open tickets stay yours.'
          : 'New tickets are not being assigned to you. Your existing tickets are unaffected.'}
      </InfoTip>
    </div>
  );
}

/**
 * Who parked them. A supervisor's name is not stored — only that it was one —
 * and the idle line states the policy's threshold, not a live elapsed time,
 * because the threshold is all the header knows. Null when the row carries no
 * reason, which a switch turned off before the column existed can: guessing
 * one would tell the agent something nobody recorded.
 */
function reasonLine(
  reason: SessionAgent['acceptingOffReason'],
  awayAfterMins: number | null,
): string | null {
  switch (reason) {
    case 'self':
      return 'You set this';
    case 'supervisor':
      return 'Set by a supervisor';
    case 'idle':
      return awayAfterMins === null ? 'Away while idle' : `Away after ${awayAfterMins} min idle`;
    case null:
      return null;
  }
}
