'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keeps the console fresh without polling.
 *
 * Subscribes to the SSE stream and calls `router.refresh()` when something
 * changes, which re-runs the server components the agent is currently looking
 * at. Refreshing rather than patching client state is deliberate: the list and
 * the ticket both derive from authorised server queries, so there is no way for
 * a stream message to put data on screen the agent should not see.
 *
 * Falls back to a slow poll if the stream cannot be established — better a
 * 60-second lag than a console that silently stops updating.
 */
export function LiveUpdates() {
  const router = useRouter();

  useEffect(() => {
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;

    const startPolling = () => {
      if (poll) return;
      poll = setInterval(() => router.refresh(), 60_000);
    };

    // Coalesce bursts: a batch of WhatsApp statuses can fire a dozen
    // notifications in a second, and each refresh is a round of server renders.
    const refreshSoon = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        router.refresh();
      }, 750);
    };

    try {
      source = new EventSource('/api/events');
      source.addEventListener('conversation', refreshSoon);
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
      if (pending) clearTimeout(pending);
    };
  }, [router]);

  return null;
}
