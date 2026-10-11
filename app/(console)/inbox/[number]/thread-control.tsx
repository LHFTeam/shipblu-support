'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui';
import { claimThreadControl } from '../../meta-actions';
import { INITIAL } from './form-state';

/**
 * Takes the thread off whichever app is answering it, so this one can reply.
 *
 * Sits under the explanation in the composer rather than beside the tabs,
 * because it is the *answer* to that paragraph: the agent reads why the ticket
 * cannot be answered and the remedy is the next thing under it. Anywhere else
 * and the paragraph still ends in "go and use the other tool".
 *
 * A refusal is rendered here and left on screen, exactly as `ProfileRefresh`
 * does and for the same reason. The refusal that matters — this app is not the
 * primary receiver — is a sentence the agent has to hand to whoever holds the
 * Meta dashboard, and a toast would take it away before they had read it twice.
 *
 * A success has nothing to say here, because this component does not survive
 * it. The action writes the event that reopens the composer and revalidates the
 * ticket, the re-read page comes back with the action's answer, and the
 * composer puts the reply box where this was. Measured, the answer was never
 * painted (§6.89). The reply box is the answer, and the ticket's activity
 * records who took control.
 */
export function ThreadControl({ conversationId }: { conversationId: string }) {
  const [state, formAction] = useActionState(claimThreadControl, INITIAL);

  return (
    <div className="mt-3">
      <form action={formAction}>
        <input type="hidden" name="conversationId" value={conversationId} />
        <Submit />
      </form>

      {state.error ? (
        <p className="mt-2 whitespace-pre-line text-xs text-red-600">{plain(state.error)}</p>
      ) : null}
    </div>
  );
}

function Submit() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" variant="secondary" disabled={pending}>
      {pending ? 'Asking Meta…' : 'Take thread control'}
    </Button>
  );
}

/**
 * The explanations in `lib/meta/errors.ts` mark their key terms with `**`, which
 * is right for a log line and literal asterisks in a browser. Stripped here for
 * the reason `profile-refresh.tsx` strips them there: the same strings are read
 * in three places and only these two render.
 */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1');
}
