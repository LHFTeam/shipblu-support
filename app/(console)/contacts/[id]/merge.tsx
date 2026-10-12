'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge, ErrorText } from '@/components/ui';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { SearchInput } from '@/components/search-input';
import type { MergeCandidate } from '@/lib/contacts/merge';
import { mergeContactInto, type ContactActionState } from '../actions';

const INITIAL: ContactActionState = { error: null };

/**
 * Finding the duplicate.
 *
 * A `merge` query parameter rather than a client-side fetch, so the search runs
 * in the same server query the suggestions do and there is no second code path
 * that could show a contact this agent may not see. Debounced and held in a ref
 * exactly like the contact and inbox search boxes — a new closure per render
 * restarts the timer, and with `push` in the deps the search fires late or never.
 */
export function MergeSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [value, setValue] = useState(initial);

  const push = (next: string) => {
    const search = new URLSearchParams(params.toString());
    if (next) search.set('merge', next);
    else search.delete('merge');
    router.push(`${pathname}?${search.toString()}`);
  };

  const latest = useRef(push);
  useEffect(() => {
    latest.current = push;
  });

  useEffect(() => {
    if (value === initial) return;
    const timer = setTimeout(() => latest.current(value), 350);
    return () => clearTimeout(timer);
  }, [value, initial]);

  return (
    <SearchInput
      className="max-w-sm"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder="Find by name, email or phone"
      aria-label="Search for a duplicate contact"
    />
  );
}

const REASONS: Record<NonNullable<MergeCandidate['reason']>, string> = {
  email: 'Same email',
  phone: 'Same phone',
  name: 'Same name',
};

/**
 * One candidate, and the button that folds it in.
 *
 * The row says what would move before it is moved, because "3 tickets" is the
 * whole difference between merging a stray duplicate and merging away somebody's
 * history. The confirm is a second, separate click on the same button. It was
 * the first click until §6.90: the button turned into a submit inside its own
 * click handler, and that click then submitted it.
 */
export function MergeCandidateRow({
  survivorId,
  candidate,
}: {
  survivorId: string;
  candidate: MergeCandidate;
}) {
  const [state, action] = useActionState(mergeContactInto, INITIAL);

  const label = candidate.name ?? candidate.email ?? candidate.phone ?? 'Unnamed contact';
  const handle = [candidate.email, candidate.phone].filter(Boolean).join(' · ');

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-(--color-border-subtle) py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <Link href={`/contacts/${candidate.id}`} className="text-sm font-medium hover:underline">
          {label}
        </Link>
        {handle ? (
          <span className="ms-2 text-xs text-(--color-text-secondary)">{handle}</span>
        ) : null}
        <p className="text-xs text-(--color-text-secondary)">
          {candidate.conversations} ticket{candidate.conversations === 1 ? '' : 's'} ·{' '}
          {candidate.identities} identit{candidate.identities === 1 ? 'y' : 'ies'} would move here
        </p>
      </div>

      {candidate.reason ? <Badge tone="warning">{REASONS[candidate.reason]}</Badge> : null}

      <form action={action} className="flex flex-col items-end gap-1">
        <input type="hidden" name="survivorId" value={survivorId} />
        <input type="hidden" name="loserId" value={candidate.id} />
        <ConfirmSubmit label="Merge" confirmLabel="Merge into this contact" />
        {state.error ? <ErrorText>{state.error}</ErrorText> : null}
      </form>
    </li>
  );
}
