'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, ErrorText } from '@/components/ui';
import { SearchIcon } from '@/components/icons';
import { useRefreshOnSuccess } from '@/components/use-refresh-on-success';
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
    <div className="relative max-w-sm">
      <span className="pointer-events-none absolute inset-y-0 start-2 flex items-center opacity-50">
        <SearchIcon size={14} />
      </span>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Find a duplicate by name, email or phone"
        aria-label="Search for a duplicate contact"
        className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-1.5 pe-3 ps-7 text-xs outline-none focus:border-brand-500"
      />
    </div>
  );
}

const REASONS: Record<NonNullable<MergeCandidate['reason']>, string> = {
  email: 'same email',
  phone: 'same phone',
  name: 'same name',
};

/**
 * One candidate, and the button that folds it in.
 *
 * The row says what would move before it is moved, because "3 tickets" is the
 * whole difference between merging a stray duplicate and merging away somebody's
 * history. The confirm is a second click on the same button — enough to stop a
 * mis-click, and it needs no focus trap to be accessible.
 */
export function MergeCandidateRow({
  survivorId,
  candidate,
}: {
  survivorId: string;
  candidate: MergeCandidate;
}) {
  const [state, action] = useActionState(mergeContactInto, INITIAL);
  const [armed, setArmed] = useState(false);
  useRefreshOnSuccess(state);

  const label = candidate.name ?? candidate.email ?? candidate.phone ?? 'Unnamed contact';
  const handle = [candidate.email, candidate.phone].filter(Boolean).join(' · ');

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border)] py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <Link href={`/contacts/${candidate.id}`} className="text-sm font-medium hover:underline">
          {label}
        </Link>
        {handle ? <span className="ms-2 text-xs opacity-60">{handle}</span> : null}
        <p className="text-xs text-[var(--muted-foreground)]">
          {candidate.conversations} ticket{candidate.conversations === 1 ? '' : 's'} ·{' '}
          {candidate.identities} identit{candidate.identities === 1 ? 'y' : 'ies'} would move here
        </p>
      </div>

      {candidate.reason ? <Badge tone="warning">{REASONS[candidate.reason]}</Badge> : null}

      <form action={action} className="flex flex-col items-end gap-1">
        <input type="hidden" name="survivorId" value={survivorId} />
        <input type="hidden" name="loserId" value={candidate.id} />
        {armed ? (
          <Button type="submit" variant="danger" size="sm">
            Merge into this contact
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => setArmed(true)}>
            Merge
          </Button>
        )}
        {state.error ? <ErrorText>{state.error}</ErrorText> : null}
      </form>
    </li>
  );
}
