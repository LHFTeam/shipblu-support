'use client';

import { useState } from 'react';
import { useConfirmClick } from '@/components/confirm-submit';
import { InfoTip } from '@/components/tooltip';
import { Button } from '@/components/ui';
import { useNow } from '@/components/use-now';
import { formatTime } from '@/lib/format';
import type { HandToTarget } from '@/lib/routing/hand-to';
import type { HoldColumns } from '@/lib/routing/hold';
import { routingHold } from '@/lib/tickets/inbox-badges';
import { handToGroup } from '../../ticket-actions';
import { FieldError } from './ticket-fields';
import { useFieldAction } from './use-field-action';

/**
 * "Hand to <group>", under the Category field: after routing has decided a
 * ticket, a category edit only relabels it, and this is what then moves it to
 * the new category's group, takes it off whoever holds it and assigns it
 * there (`lib/routing/hand-to.ts`). The page decides whether it is offered;
 * the action decides again from the ticket's locked row and refuses anything
 * the page no longer knows, which re-reads the page (`rereadOnRefusal`).
 *
 * One click, as the plan has it, unless it would take the ticket off a
 * colleague: then two, through `useConfirmClick`, because the click ends work
 * somebody else is part-way through. One `type="button"` throughout, whose
 * handler and words change when armed.
 *
 * Mounted while there is nothing to offer too, keyed on the ticket by the
 * sidebar: a success moves the ticket into the group, which withdraws the
 * offer, and the action's sentence about nobody being free there has to
 * outlive the button that asked.
 */
export function HandToGroup({
  conversationId,
  target,
  clears,
}: {
  conversationId: string;
  target: HandToTarget | null;
  /** The colleague the hand-over would unassign, by name; null when it takes nobody else's ticket. */
  clears: string | null;
}) {
  const { pending, error, run } = useFieldAction(handToGroup, { rereadOnRefusal: true });
  const [message, setMessage] = useState<string | null>(null);

  async function hand() {
    if (!target) return;
    setMessage(null);
    const result = await run({ conversationId, groupId: target.groupId });
    setMessage(result.message ?? null);
  }
  const confirm = useConfirmClick(hand);

  return (
    <>
      {target ? (
        <div className="mt-2 flex items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={clears ? confirm.onClick : () => void hand()}
            onKeyDown={clears ? confirm.onKeyDown : undefined}
            onBlur={confirm.disarm}
          >
            {confirm.armed && clears
              ? `Unassign ${clears} and hand over?`
              : `Hand to ${target.groupName}`}
          </Button>
          <InfoTip label="handing to a group">
            Moves the ticket to {target.groupName}, the group its category routes to, takes it off
            whoever holds it, and gives it to somebody there by that group&apos;s own rota. Once
            routing is over, or on a channel that does not route, changing the category only
            relabels the ticket; this is what moves it.
          </InfoTip>
        </div>
      ) : null}
      <FieldError>{error}</FieldError>
      {message ? <p className="mt-1 text-xs text-(--color-text-secondary)">{message}</p> : null}
    </>
  );
}

/**
 * While the ticket is held for routing, what a control beside it would do to
 * the route — the risk the plan names: an agent who takes a held ticket ends
 * its route, which nothing stops, because a person is never overruled; this
 * says so before they do. Read by the list row's own rule (`routingHold`) on
 * its clock, so the field and the row cannot disagree. Its own component, so
 * the clock re-renders the line and not the sidebar.
 */
export function RoutingHint({ hold, does }: { hold: HoldColumns; does: string }) {
  const now = useNow();
  const held = routingHold(hold, now);
  if (!held) return null;
  return (
    <p className="mt-1 text-xs text-(--color-text-secondary)">
      Held for routing{held.until ? ` until ${formatTime(held.until)}` : ''}. {does}
    </p>
  );
}
