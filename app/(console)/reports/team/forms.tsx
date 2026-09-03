'use client';

import { useActionState } from 'react';
import { Button, ErrorText } from '@/components/ui';
import { setAgentAvailability, type AvailabilityState } from '../../actions';

const INITIAL: AvailabilityState = { error: null };

/**
 * One agent's availability, set by somebody else.
 *
 * The same shape as the agent's own switch in the console header, and
 * deliberately so — the two write the same column through the same function,
 * and a supervisor reading a different control would eventually believe they
 * were different settings.
 *
 * Optimistic in exactly one respect: the label follows the action's own answer
 * rather than the server-rendered prop, so a supervisor working down a list of
 * eight agents is not waiting for a full revalidation between clicks.
 */
export function AvailabilityControl({
  agentId,
  name,
  accepting,
}: {
  agentId: string;
  name: string;
  accepting: boolean;
}) {
  const [state, action, pending] = useActionState(setAgentAvailability, INITIAL);
  const on = state.accepting ?? accepting;

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="accepting" value={on ? 'false' : 'true'} />
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        disabled={pending}
        // The name is in the accessible label rather than the visible one: the
        // column is a list of identical buttons, so "Stop routing work" read out
        // eight times says nothing about which row it belongs to.
        aria-label={on ? `Stop routing work to ${name}` : `Start routing work to ${name}`}
      >
        {on ? 'Set away' : 'Set accepting'}
      </Button>
      <ErrorText>{state.error}</ErrorText>
    </form>
  );
}
