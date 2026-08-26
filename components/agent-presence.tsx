'use client';

import { useEffect } from 'react';

/**
 * Keeps assignment presence alive anywhere in the signed-in console.
 *
 * Presence used to share the global conversation stream. Live updates now
 * belong only to inbox routes, but an agent reading a contact or configuring a
 * channel is still at work and must not silently stop receiving assignments.
 * This stream carries heartbeats only and holds no PostgreSQL LISTEN connection.
 */
export function AgentPresence() {
  useEffect(() => {
    let source: EventSource | null = null;

    try {
      source = new EventSource('/api/presence');
    } catch {
      // A failed constructor has no useful client-side recovery. EventSource
      // handles ordinary disconnects itself, and server-side staleness keeps a
      // missing sign-off from marking the agent online forever.
    }

    return () => source?.close();
  }, []);

  return null;
}
