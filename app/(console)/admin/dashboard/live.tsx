'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useNow } from '@/components/use-now';

/**
 * The "live" half of the live dashboard.
 *
 * The console already refreshes when a conversation changes — that is the SSE
 * stream in the layout — but half of what this page shows changes without any
 * conversation changing at all: a due date passing, the job queue backing up, a
 * webhook going unprocessed. So this ticks on its own as well.
 *
 * Two rules keep the cost honest. It refreshes only while the tab is visible,
 * because a dashboard left open on a laptop lid should cost nothing; and it
 * refreshes rather than fetching, so every figure still comes from the same
 * authorised server render and the client never learns anything the agent could
 * not otherwise see.
 */

const INTERVAL_MS = 20_000;

export function LiveTicker({ renderedAt }: { renderedAt: string }) {
  const router = useRouter();
  const [live, setLive] = useState(true);
  // Null until mounted — the server has no "seconds ago" to render. One second
  // is the resolution this readout needs and nothing else on the page reads it.
  const now = useNow(1_000);
  const secondsAgo = now
    ? Math.max(0, Math.round((now.getTime() - new Date(renderedAt).getTime()) / 1000))
    : null;

  useEffect(() => {
    if (!live) return;

    const refresh = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };

    const timer = setInterval(refresh, INTERVAL_MS);
    // A tab coming back to the front is stale by definition — however long it
    // was hidden, the first thing the reader does is look at the numbers.
    document.addEventListener('visibilitychange', refresh);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [live, router]);

  return (
    <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
      <span
        aria-hidden
        className={`size-2 rounded-full ${
          live ? 'animate-pulse bg-[var(--color-positive)]' : 'bg-[var(--border-strong)]'
        }`}
      />
      <span aria-live="off">
        {secondsAgo === null
          ? 'Live'
          : secondsAgo < 5
            ? 'Updated just now'
            : `Updated ${secondsAgo}s ago`}
      </span>
      <button
        type="button"
        onClick={() => setLive((on) => !on)}
        className="rounded-md px-1.5 py-0.5 hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
      >
        {live ? 'Pause' : 'Resume'}
      </button>
      <button
        type="button"
        onClick={() => router.refresh()}
        className="rounded-md px-1.5 py-0.5 hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
      >
        Refresh
      </button>
    </div>
  );
}
