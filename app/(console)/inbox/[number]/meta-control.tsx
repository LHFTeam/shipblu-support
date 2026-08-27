'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Button, ErrorText } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { describeAppId } from '@/lib/meta/control';
import type { MetaControlView } from '@/lib/tickets/meta-control';
import {
  readConversationControl,
  transferConversationControl,
  type MetaControlActionState,
} from '../../actions';

const INITIAL: MetaControlActionState = { error: null, view: null, result: null };

/**
 * Who holds this Messenger or Instagram conversation, and the one button that
 * moves it.
 *
 * Facebook accepts a reply only from the app that owns the thread. Until now
 * the console could say that a ticket was unanswerable and nothing more — the
 * fix was a trip into Meta's Page settings, in a tool most agents cannot open.
 * This is that fix, in the place the agent already is.
 *
 * The reading is live rather than server-rendered with the ticket. Control
 * moves without telling us and a page can sit open for an hour, so a value
 * baked into the HTML would be a confident answer to a question nobody had
 * asked recently. It also costs a Graph round trip, which is not something to
 * put on the render path of every Facebook ticket when most of them are never
 * going to need it.
 */
export function MetaControlBar({
  conversationId,
  /** What the ticket's server-rendered verdict already knows, shown until the
      live read lands so the strip never starts blank. */
  standby,
}: {
  conversationId: string;
  standby: boolean;
}) {
  const [state, action] = useActionState(transferConversationControl, INITIAL);
  const [read, setRead] = useState<MetaControlActionState | null>(null);
  const [checking, startChecking] = useTransition();
  const router = useRouter();

  // One read per ticket on open. `conversationId` is the dependency rather than
  // nothing at all: this component survives a client-side navigation between
  // two tickets, and without it the second one would show the first one's owner.
  useEffect(() => {
    let current = true;
    startChecking(async () => {
      const result = await readConversationControl(conversationId);
      if (current) setRead(result);
    });
    return () => {
      current = false;
    };
  }, [conversationId]);

  /*
    The reply box is gated on the *server's* thread verdict, which a successful
    transfer has just changed. Refreshing is what turns "this ticket cannot be
    answered from here" back into a textarea; the button flipping on its own
    would be the more confusing half of a half-applied change.
  */
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.nonce, router]);

  // The action's own view is the freshest thing available — it was read after
  // the transfer landed — so it outranks the read taken when the ticket opened.
  const view: MetaControlView | null = state.view ?? read?.view ?? null;
  const permissionError = read?.error && !read.view ? read.error : null;

  // Nothing inbound to own, or not a ticket with a thread at all. Silence beats
  // a button with no label on it — `available: false` carries an empty state
  // deliberately, because there is nothing true to put in one.
  if (view && !view.available) return null;
  if (read && !read.view && !permissionError && !checking) return null;

  const intent = view?.state.intent ?? (standby ? 'take' : 'release');
  const label = view?.state.label ?? (standby ? 'Transfer control to this app' : 'Release control');

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-3 py-2 text-xs">
      <span className="flex items-center gap-1 text-[var(--muted-foreground)]">
        {checking && !view ? 'Checking who holds this conversation…' : holderLine(view, standby)}
        {view?.state.explanation ? (
          <InfoTip label="thread control">{view.state.explanation}</InfoTip>
        ) : null}
      </span>

      {view?.state.blockedReason ? (
        <span className="text-[var(--muted-foreground)] opacity-70">
          {view.state.blockedReason}
        </span>
      ) : (
        <form action={action} className="ms-auto flex items-center gap-2">
          <input type="hidden" name="conversationId" value={conversationId} />
          <input type="hidden" name="intent" value={intent} />
          <ControlButton label={label} intent={intent} disabled={checking && !view} />
        </form>
      )}

      {/* Reported rather than smoothed over: a request is an ask the other app
          may ignore, and an agent told "transferred" would start typing. */}
      {state.result === 'requested' ? (
        <span className="basis-full text-[var(--muted-foreground)]">
          This app is not the primary receiver for this inbox, so control could not be taken
          outright. The current owner has been asked to hand the thread over and may decline —
          reopen this ticket in a moment to see whether it did.
        </span>
      ) : null}

      {state.result === 'taken' ? (
        <span className="basis-full text-[var(--muted-foreground)]">
          This app now owns the thread. Replies sent from here will reach the customer.
        </span>
      ) : null}

      {state.result === 'released' ? (
        <span className="basis-full text-[var(--muted-foreground)]">
          The thread is back to idle, so the page&rsquo;s default app answers from here on.
        </span>
      ) : null}

      {view?.stale ? (
        <span className="basis-full text-[var(--muted-foreground)] opacity-70">
          Meta did not answer when asked who holds this thread, so the state above is inferred from
          the last message rather than confirmed.
        </span>
      ) : null}

      {state.error ? (
        <span className="basis-full">
          <ErrorText>{state.error}</ErrorText>
        </span>
      ) : null}
      {permissionError ? (
        <span className="basis-full">
          <ErrorText>{permissionError}</ErrorText>
        </span>
      ) : null}
    </div>
  );
}

function holderLine(view: MetaControlView | null, standby: boolean): string {
  if (!view) {
    return standby ? 'Another app owns this conversation' : 'Thread control';
  }

  switch (view.state.holder) {
    case 'us':
      return 'This app owns this conversation';
    case 'other':
      return view.state.ownerAppId
        ? `${sentenceCase(describeAppId(view.state.ownerAppId))} owns this conversation`
        : 'Another app owns this conversation';
    case 'idle':
      return 'No app owns this conversation';
    default:
      return standby ? 'Another app owns this conversation' : 'Thread control';
  }
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function ControlButton({
  label,
  intent,
  disabled,
}: {
  label: string;
  intent: 'take' | 'release';
  disabled: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant={intent === 'take' ? 'secondary' : 'ghost'}
      size="sm"
      disabled={disabled || pending}
    >
      {pending ? (intent === 'take' ? 'Transferring…' : 'Releasing…') : label}
    </Button>
  );
}
