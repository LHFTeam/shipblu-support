'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui';
import { useRefreshOnSuccess } from '@/components/use-refresh-on-success';
import { refreshRequesterProfile } from '../../meta-actions';
import { INITIAL } from './form-state';

/**
 * Asks Meta again who this customer is.
 *
 * Only on Facebook and Instagram, because they are the only channels with
 * anything to ask: a WhatsApp webhook carries the profile name in the payload
 * and an email address has no profile behind it. On those two the customer
 * arrives as a bare scoped id, and until Meta answers the ticket is filed under
 * a seventeen-digit number.
 *
 * The outcome is rendered here rather than announced and dropped. When it
 * fails, Meta's own sentence is the useful half — "the app is not approved for
 * this" and "that person is gone" are the same event from the console's point
 * of view and completely different ones from the Meta dashboard's — and the
 * agent is going to be reading it out to whoever holds that dashboard. A toast
 * would take it away in four seconds.
 */
export function ProfileRefresh({
  conversationId,
  hasName,
}: {
  conversationId: string;
  hasName: boolean;
}) {
  const [state, formAction] = useActionState(refreshRequesterProfile, INITIAL);

  // The name and picture land on the contact, which the header reads through
  // the page's own query — so the header only tells the truth again once the
  // route has been re-read.
  useRefreshOnSuccess(state);

  return (
    <>
      <form action={formAction} className="inline-flex">
        <input type="hidden" name="conversationId" value={conversationId} />
        <Submit label={hasName ? 'Refresh profile' : 'Fetch name from Meta'} />
      </form>

      {state.error || state.message ? (
        <Outcome failed={Boolean(state.error)}>{state.error ?? state.message ?? ''}</Outcome>
      ) : null}
    </>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" variant="ghost" disabled={pending}>
      {pending ? 'Asking Meta…' : label}
    </Button>
  );
}

/**
 * The answer, on its own line.
 *
 * `basis-full` rather than a block of its own: the header is one wrapping flex
 * row and a refusal runs to several sentences, so it takes a whole line instead
 * of stretching the row the name and the badges sit on.
 */
function Outcome({ children, failed }: { children: string; failed: boolean }) {
  return (
    <p
      className={`mt-1 basis-full whitespace-pre-line text-xs ${
        failed ? 'text-red-600' : 'text-[var(--muted-foreground)]'
      }`}
    >
      {plain(children)}
    </p>
  );
}

/**
 * The explanations in `lib/meta/errors.ts` mark their key terms with `**`,
 * which is right for a log line and a PR body and is literal asterisks in a
 * browser. Stripped here rather than there: the same string is read in three
 * places and only this one renders.
 */
function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1');
}
