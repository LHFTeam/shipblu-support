'use client';

import { useEffect, useRef } from 'react';

/**
 * Reports that this agent is actually working this ticket.
 *
 * Handling time is the one figure on the productivity report that nothing in the
 * system could previously observe: a ticket has no timer, and the gap between
 * two replies is mostly the customer thinking. So the page says so — but only
 * while all three of these hold, and each one removes a specific lie the naive
 * version would tell:
 *
 *  - **The tab is visible.** A ticket in a background tab is not being worked.
 *  - **The window has focus.** A console sitting behind the shipping platform is
 *    not being worked either, and this is the common case for a support agent
 *    with two systems open.
 *  - **Somebody has moved recently.** A ticket left open over lunch is the
 *    single largest way this measurement could be inflated, and an idle timeout
 *    is the only thing that catches it.
 *
 * An agent with three tickets open therefore beats from one of them, so
 * concurrency cannot buy more hours than the day contained — which is what keeps
 * occupancy a ratio rather than a number that can exceed 100%.
 *
 * What this measures is attention on this page, not effort. Looking a shipment
 * up in another system, or a phone call about the ticket, is invisible here. The
 * report says as much rather than letting the figure be read as a contact
 * centre's handle time, which includes after-contact work.
 */

/** Matches FOCUS_TTL_MS server-side: two missed beats end the span. */
const BEAT_MS = 30_000;

/**
 * How long without input before we stop claiming the agent is on this ticket.
 *
 * Two minutes rather than something tighter because reading a long email thread
 * is legitimately motionless work, and undercounting that would push agents
 * towards fidgeting to keep their numbers up — which is worse than the
 * occasional over-count it prevents.
 */
const IDLE_MS = 2 * 60_000;

export function FocusBeat({ conversationId }: { conversationId: string }) {
  // Zero rather than `Date.now()`: a ref initialiser runs during render, where
  // reading the clock is impure. The effect below sets it before the first beat
  // can look at it.
  const lastInput = useRef(0);
  const holding = useRef(false);

  useEffect(() => {
    lastInput.current = Date.now();
    holding.current = false;

    const url = '/api/focus';
    const body = (release?: boolean) => JSON.stringify({ conversationId, release });

    const send = (release?: boolean) => {
      void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body(release),
        keepalive: true,
      }).catch(() => {
        // A dropped beat costs at most one interval of measurement. It must
        // never surface to the agent, who did not ask to be measured and cannot
        // act on the failure.
      });
    };

    const release = () => {
      if (!holding.current) return;
      holding.current = false;

      // `sendBeacon` is the only thing that reliably survives the page going
      // away; a normal fetch is cancelled mid-flight on navigation.
      const beacon = new Blob([body(true)], { type: 'application/json' });
      if (!navigator.sendBeacon?.(url, beacon)) send(true);
    };

    const working = () =>
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      Date.now() - lastInput.current < IDLE_MS;

    const tick = () => {
      if (working()) {
        holding.current = true;
        send();
      } else {
        release();
      }
    };

    const noteInput = () => {
      lastInput.current = Date.now();
    };

    // `passive` on all of them: none of these prevent default, and a
    // non-passive scroll listener on a long ticket timeline is a visible jank.
    const inputs = ['pointerdown', 'keydown', 'scroll', 'wheel'] as const;
    for (const event of inputs) window.addEventListener(event, noteInput, { passive: true });

    // Reacting to these as well as polling means hiding the tab stops the clock
    // immediately rather than up to thirty seconds later.
    const onVisibility = () => (document.visibilityState === 'visible' ? tick() : release());
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', release);
    window.addEventListener('focus', tick);
    window.addEventListener('pagehide', release);

    tick();
    const timer = setInterval(tick, BEAT_MS);

    return () => {
      clearInterval(timer);
      for (const event of inputs) window.removeEventListener(event, noteInput);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', release);
      window.removeEventListener('focus', tick);
      window.removeEventListener('pagehide', release);
      // Moving to another ticket closes this span rather than leaving it to go
      // stale, so a ticket glanced at for ten seconds costs ten seconds.
      release();
    };
  }, [conversationId]);

  return null;
}
