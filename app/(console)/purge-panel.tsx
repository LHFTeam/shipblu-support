'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorText } from '@/components/ui';
import { confirmationMatches, describePurgeCounts, RETAINED } from '@/lib/admin/purge-summary';
import type { PurgePreview } from '@/lib/admin/purge-summary';

// Only a refusal ever comes back: success redirects from the action instead.
type PurgeState = { error: string | null };

/**
 * The confirmation an irreversible delete is worth.
 *
 * The console's usual pattern for a destructive button is arm-then-confirm — a
 * second click on the same control, which is what `MergeCandidateRow` uses and
 * is right for a merge, because a merge that was wrong can be walked back by
 * hand. This cannot, so it asks for something a mis-click cannot produce: the
 * ticket number, or the customer's own address, typed back.
 *
 * Three things follow from that and are worth not undoing later.
 *
 * The button is **disabled until the text matches**, and the same check runs
 * again in `purgeConversation()` / `purgeContact()` against the locked row. The
 * client copy is there to stop somebody wasting a round trip; the server copy is
 * the one that decides, because a `FormData` field is never the authority on
 * what is being destroyed.
 *
 * The counts come from the server as a **preview and are labelled as one**. They
 * were true when the page rendered, and the transaction recounts before it
 * deletes — a ticket that arrived in between goes too, and the audit row records
 * the transaction's numbers rather than these.
 *
 * It does not navigate on success, and must not be made to. The action
 * redirects: a revalidating action re-renders the page it was posted from, which
 * is the one just deleted, so its notFound() would win the race against any
 * effect here. A successful purge therefore never hands this component a state
 * — only a refusal does, and that is the only thing it renders from `state`.
 *
 * And it says what it does **not** delete. "Completely delete" is the phrase
 * that gets asked for, and the webhook archive, finished jobs, their words on
 * other tickets and the deletion record itself all survive this — `RETAINED`
 * has the list and the reasons. An admin who needs a real erasure should find
 * that out here rather than from a report six weeks later.
 */
export function PurgePanel({
  preview,
  action,
  idField,
  noun,
  confirmationHint,
  refusal = null,
}: {
  preview: PurgePreview;
  action: (state: PurgeState, formData: FormData) => Promise<PurgeState>;
  /** Name of the hidden field carrying the id — `conversationId` or `contactId`. */
  idField: string;
  /** 'ticket' | 'contact', for the button and the prose. */
  noun: string;
  /** What the typed value is, in words: 'the ticket number', 'the email address'. */
  confirmationHint: string;
  /**
   * Why this admin may not purge it even holding the permission — today, a
   * ticket in scope on a channel they cannot see. Shown in place of the button,
   * so nobody types a confirmation the action is certain to refuse; the action
   * still checks for itself.
   */
  refusal?: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null } as PurgeState);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  const destroyed = describePurgeCounts(preview.counts);
  const armed = confirmationMatches(preview.confirmation, typed);

  if (refusal) {
    return <p className="text-xs text-[var(--muted-foreground)]">{refusal}</p>;
  }

  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Delete this {noun}…
      </Button>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-critical)]/40 p-3">
      <p className="text-xs font-medium">Permanently delete {preview.summary}?</p>

      <p className="mt-2 text-xs text-[var(--muted-foreground)]">
        {destroyed.length > 0 ? (
          <>
            Preview: this destroys <span className="font-medium">{destroyed.join(', ')}</span>, and
            the files on them. It cannot be undone.
          </>
        ) : (
          <>There is nothing on it yet. It cannot be undone.</>
        )}
      </p>

      {preview.counts.shipmentsDetached > 0 ? (
        <p className="mt-2 text-xs text-[var(--muted-foreground)]">
          {preview.counts.shipmentsDetached} shipment
          {preview.counts.shipmentsDetached === 1 ? '' : 's'} will be kept, with this person unset
          as the shipper or recipient — a parcel is a record of something that happened.
        </p>
      ) : null}

      {preview.ticketNumbers.length > 0 ? (
        <p className="mt-2 text-xs text-[var(--muted-foreground)]">
          Tickets going with it:{' '}
          <span className="font-medium">
            {preview.ticketNumbers
              .slice(0, 12)
              .map((number) => `#${number}`)
              .join(', ')}
            {preview.ticketNumbers.length > 12
              ? ` and ${preview.ticketNumbers.length - 12} more`
              : ''}
          </span>
        </p>
      ) : null}

      {/* A list rather than one joined sentence: there are six of these now,
          and a run-on clause is the part of a warning that gets skimmed. */}
      <div className="mt-2 text-xs text-[var(--muted-foreground)]">
        <p>Not deleted:</p>
        <ul className="mt-1 list-disc ps-4">
          {RETAINED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <form action={formAction} className="mt-3 flex flex-col gap-2">
        <input type="hidden" name={idField} value={preview.id} />

        <label className="text-xs" htmlFor={`purge-confirm-${preview.id}`}>
          Type {confirmationHint} — <span className="font-medium">{preview.confirmation}</span> — to
          confirm.
        </label>
        <input
          id={`purge-confirm-${preview.id}`}
          name="confirmation"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          disabled={pending}
          aria-label={`Type ${confirmationHint} to confirm deletion`}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-base outline-none sm:text-xs focus:border-[var(--color-critical)]"
        />

        <div className="flex items-center gap-2">
          <Button type="submit" variant="danger" size="sm" disabled={!armed || pending}>
            {pending ? 'Deleting…' : 'Delete permanently'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setOpen(false);
              setTyped('');
            }}
          >
            Cancel
          </Button>
        </div>

        {state.error ? <ErrorText>{state.error}</ErrorText> : null}
      </form>
    </div>
  );
}
