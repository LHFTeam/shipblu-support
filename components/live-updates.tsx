'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshScheduler } from '@/lib/realtime/refresh-scheduler';
import type { QueueChannel } from '@/lib/realtime/topics';

/**
 * Keeps the inbox and, when present, its open ticket fresh.
 *
 * The server stream is scoped to the queue channel and conversation the server
 * already authorised. The payload remains an invalidation signal rather than
 * row data: `router.refresh()` re-runs the normal authorised queries, so a
 * notification cannot put a ticket on screen by bypassing the read path.
 *
 * Refreshes are single-flight. Events that arrive during a render set one dirty
 * bit, then cause at most one trailing refresh after a cooldown. This is the
 * backpressure the old 750 ms debounce did not provide: a slow render can no
 * longer accumulate more renders behind it.
 */
export function LiveUpdates({
  channel,
  conversationId,
}: {
  channel: QueueChannel;
  conversationId?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const schedulerRef = useRef<RefreshScheduler | null>(null);
  const observedPendingRef = useRef(false);

  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!scheduler) return;

    if (isPending) {
      observedPendingRef.current = true;
    } else if (observedPendingRef.current) {
      observedPendingRef.current = false;
      scheduler.complete();
    }
  }, [isPending]);

  useEffect(() => {
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const scheduler = new RefreshScheduler({
      visible: document.visibilityState === 'visible',
      start: () => {
        startTransition(() => router.refresh());
      },
    });
    schedulerRef.current = scheduler;

    const onVisibilityChange = () => {
      scheduler.setVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const startPolling = () => {
      if (poll) return;
      poll = setInterval(() => scheduler.request(), 60_000);
    };

    const query = new URLSearchParams({ channel });
    if (conversationId) query.set('conversationId', conversationId);

    try {
      source = new EventSource(`/api/events?${query.toString()}`);
      source.addEventListener('conversation', () => scheduler.request());
      source.addEventListener('degraded', startPolling);
      source.onerror = () => {
        // EventSource reconnects on its own; polling covers the gap and is
        // cleared if the stream comes back with a fresh 'ready'.
        startPolling();
      };
      source.addEventListener('ready', () => {
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
      });
    } catch {
      startPolling();
    }

    return () => {
      source?.close();
      if (poll) clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      scheduler.dispose();
      schedulerRef.current = null;
      observedPendingRef.current = false;
    };
  }, [channel, conversationId, router, startTransition]);

  return null;
}
