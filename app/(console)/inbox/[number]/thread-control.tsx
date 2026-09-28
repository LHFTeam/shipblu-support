'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui';
import type { ActionState } from '../../action-state';
import { claimThreadControl } from '../../meta-actions';

const INITIAL: ActionState = { error: null };

/**
 * Takes the thread off whichever app is answering it, so this one can reply.
 *
 * Sits under the explanation in the composer rather than beside the tabs,
 * because it is the *answer* to that paragraph: the agent reads why the ticket
 * cannot be answered and the remedy is the next thing under it. Anywhere else
 * and the paragraph still ends in "go and use the other tool".
 *
 * The outcome is rendered here and left on screen, exactly as `ProfileRefresh`
 * does and for the same reason. The refusal that matters — this app is not the
 * primary receiver — is a sentence the agent has to hand to whoever holds the
 * Meta dashboard, and a toast would take it away before they had read it twice.
 */
export function ThreadControl({ conversationId }: { conversationId: string }) {
  const [state, formAction] = useActionState(claimThreadControl, INITIAL);
  const router = useRouter();

  // The composer is server-computed from the ticket's newest facts, and taking
  // control adds one. Nothing on this page can open the reply box on its own —
  // only the route being re-read can — so a success that did not refresh would
  // report itself and change nothing an agent could see.
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.nonce, router]);

  return (
    <div className="mt-3">
      <form action={formAction}>
        <input type="hidden" name="conversationId" value={conversationId} />
        <Submit />
      </form>

      {state.error || state.message ? (
        <p
          className={`mt-2 whitespace-pre-line text-xs ${
            state.error ? 'text-red-600' : 'text-[var(--muted-foreground)]'
          }`}
        >
          {plain(state.error ?? state.message ?? '')}
        </p>
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
