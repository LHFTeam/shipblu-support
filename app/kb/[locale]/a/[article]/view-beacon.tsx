'use client';

import { useEffect, useRef } from 'react';

/**
 * Counts a view once the page has actually rendered in a browser.
 *
 * Deliberately client-side. Counting during the server render would also count
 * every crawler, link preview and Next prefetch, and the number exists to tell
 * the team which articles people read — so the JavaScript requirement is the
 * feature, not a limitation.
 */
export function ViewBeacon({ articleId }: { articleId: string }) {
  const sent = useRef(false);

  useEffect(() => {
    // React runs effects twice in development; the ref keeps that from
    // doubling every count locally.
    if (sent.current) return;
    sent.current = true;

    const body = JSON.stringify({ articleId });

    // sendBeacon survives the page being closed straight after load, which is
    // exactly the reader who found their answer in the first paragraph.
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/kb/view', new Blob([body], { type: 'application/json' }));
      return;
    }

    void fetch('/api/kb/view', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // A missed view count is not worth surfacing to a customer.
    });
  }, [articleId]);

  return null;
}
