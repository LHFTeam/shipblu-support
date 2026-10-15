'use client';

import type { ReactNode } from 'react';
import { formatRelative } from '@/lib/format';
import { useNow } from './use-now';

/**
 * How long ago `at` was ("3m", "2h"), in a client component.
 *
 * Drawn only once the page has hydrated, and nothing before: the server and
 * the browser read the clock at different moments, so text computed on both
 * sides disagrees whenever a minute boundary falls between them, or the
 * agent's clock is off — and React answers a mismatch by rebuilding the whole
 * page (§6.96). `useNow()` is null for both of those renders and the shared
 * half-minute clock afterwards, so the text also stays current on a page left
 * open, where it used to say whatever was true when it rendered.
 *
 * `children` words the result — "Opened 3m ago", a tooltip round it — so a
 * phrase appears whole or not at all, rather than as "Opened  ago" until the
 * page hydrates. Its own component so the tick re-renders the time and not the
 * list or the sidebar round it.
 */
export function RelativeTime({
  at,
  children = (relative) => relative,
}: {
  at: Date | string;
  children?: (relative: string) => ReactNode;
}) {
  const now = useNow();
  return now ? children(formatRelative(at, now)) : null;
}
