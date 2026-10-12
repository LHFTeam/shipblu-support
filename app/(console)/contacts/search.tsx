'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SearchInput } from '@/components/search-input';

/**
 * The contact search box.
 *
 * Debounced, with the push held in a ref and kept out of the effect's
 * dependencies — the same shape as the inbox's `SearchBox`, and for the same
 * reason: a new closure on every render restarts the timer, so with it in the
 * deps array the search fires late, erratically, or never.
 */
export function ContactSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [value, setValue] = useState(initial);

  const push = (next: string) => {
    const search = new URLSearchParams(params.toString());
    if (next) search.set('q', next);
    else search.delete('q');
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
      value={value}
      onChange={(event) => setValue(event.target.value)}
      placeholder="Name, email, phone, SBID, tracking"
      aria-label="Search contacts"
    />
  );
}
