'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

/**
 * Reports that a human is using the console, and warns them before the
 * inactivity timeout signs them out.
 *
 * The server can see that a tab is open — the presence stream proves that much
 * every 25 seconds — and cannot see whether anybody is in front of it. That gap
 * is the whole reason this exists: without it, "away" and "signed out for
 * inactivity" would both be measured from a connection, and a console left open
 * on an empty desk would look like a full shift.
 *
 * Three behaviours, all driven from the same recorded moment of last input, so
 * the browser and the server can never disagree about when somebody stopped:
 *
 *  - **A beat, at most once a minute**, and only when there has been input
 *    since the last one. An idle tab therefore sends nothing at all, which is
 *    what makes silence meaningful rather than just cheap.
 *  - **One "I have gone idle" report** when the away window passes, so the
 *    switch flips as they stop rather than at the next five-minute sweep. The
 *    server re-checks it; the claim buys promptness, not trust.
 *  - **A countdown before the sign-out**, because nothing in this console
 *    drafts to storage. A half-written reply lives in the DOM and nowhere else,
 *    so a sign-out with no way to stop it throws away work somebody did.
 *
 * The sign-out itself is not enforced here and cannot be: this is a browser,
 * and a browser can be paused, throttled or closed. `getSessionAgent()` refuses
 * the session on the next request and the sweep deletes it in the background.
 * What this adds is that the agent finds out at the moment it happens instead
 * of when they next click something.
 */

/** At most one beat a minute while somebody is working. */
const BEAT_MS = 60_000;

/** How often the timers are evaluated when nothing is imminent. */
const TICK_MS = 5_000;

/** Scroll is missing on purpose — it is registered on the document below. */
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

export function AgentActivity({
  accepting,
  awayAfterMins,
  signoutAfterMins,
  warningLeadMs,
}: {
  /**
   * What the page was rendered with, so a beat can notice the server disagrees.
   * The switch in the header is server-rendered, and three things can move it
   * without this tab knowing: the idle timer, a supervisor, and the agent
   * themselves in another tab.
   */
  accepting: boolean;
  awayAfterMins: number | null;
  signoutAfterMins: number | null;
  /** Computed server-side from the policy, so both ends warn at the same moment. */
  warningLeadMs: number;
}) {
  const router = useRouter();

  // A ref, not the prop, inside the beat: the beat is memoised across renders
  // and would otherwise keep comparing against the value it closed over. Synced
  // in an effect rather than during render, which React forbids — a ref written
  // while rendering is a value that survives a discarded render attempt.
  const rendered = useRef(accepting);
  useEffect(() => {
    rendered.current = accepting;
  }, [accepting]);

  const lastInput = useRef(0);
  const lastBeat = useRef(0);
  const reportedIdle = useRef(false);
  const signingOut = useRef(false);
  /**
   * Mirrors `warning` below, because `noteInput` has to know whether it is
   * dismissing a countdown without taking the state as a dependency — a beat
   * memoised on changing state would be rebuilt on every tick.
   */
  const warningUp = useRef(false);

  const [warning, setWarning] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);

  const awayMs = awayAfterMins === null ? null : awayAfterMins * 60_000;
  const signoutMs = signoutAfterMins === null ? null : signoutAfterMins * 60_000;
  const active = awayMs !== null || signoutMs !== null;

  const signOut = useCallback(() => {
    if (signingOut.current) return;
    signingOut.current = true;

    // The redirect the endpoint answers with is not the one we want — the agent
    // needs to arrive at the login page knowing why they are there. `keepalive`
    // so the request survives the navigation that follows it.
    void fetch('/api/auth/logout', { method: 'POST', redirect: 'manual', keepalive: true })
      .catch(() => {
        // Nothing to recover here. The session is refused on the next request
        // either way, so landing on the login page is the right outcome even
        // when the sign-out request itself never left.
      })
      .finally(() => {
        window.location.replace('/login?signedOut=inactivity');
      });
  }, []);

  const beat = useCallback(
    async (idle: boolean) => {
      try {
        const response = await fetch('/api/presence/activity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(idle ? { idle: true } : {}),
        });

        // The session is gone — but this tab does not know why, and there are
        // several: the sweep, an admin deactivating them, a password change in
        // another tab. Only the countdown below can honestly claim inactivity,
        // so this says the neutral thing. A hidden tab throttled past its own
        // countdown lands here too, which is what stops it sitting on a dead
        // session until somebody clicks something.
        if (response.status === 401) {
          window.location.replace('/login?signedOut=session');
          return;
        }

        if (!response.ok) return;

        const outcome = (await response.json()) as { accepting?: boolean };
        // The header switch is server-rendered, so a change this tab did not
        // make — coming back from an automatic away, or a supervisor setting
        // it — would otherwise sit there being wrong until the next navigation.
        if (typeof outcome.accepting === 'boolean' && outcome.accepting !== rendered.current) {
          router.refresh();
        }
      } catch {
        // A dropped beat costs at most one interval. The agent did not ask to be
        // measured and cannot act on the failure, so it never surfaces.
      }
    },
    [router],
  );

  const noteInput = useCallback(() => {
    const now = Date.now();
    lastInput.current = now;

    // Whatever the countdown was about, they are here.
    const dismissing = warningUp.current;
    warningUp.current = false;
    setWarning(false);

    // Straight back to the server when they return from an automatic away, so
    // the rota starts including them again in seconds rather than at the next
    // beat.
    const returning = reportedIdle.current;
    reportedIdle.current = false;

    // `dismissing` bypasses the throttle deliberately. Pressing "Stay signed
    // in" has to move the server's clock *now* — on a short window the throttle
    // is longer than the window itself, so a throttled dismissal would leave
    // the agent watching a countdown they cannot stop.
    if (returning || dismissing || now - lastBeat.current >= BEAT_MS) {
      lastBeat.current = now;
      void beat(false);
    }
  }, [beat]);

  useEffect(() => {
    if (!active) return;

    lastInput.current = Date.now();
    // Zero, not now: a page load is not itself input — a tab restored by the
    // browser at startup would otherwise refresh the clock with nobody there —
    // but the *first* thing the agent does has to reach the server immediately.
    // Seeded to the mount time, an agent who reloads with a session already 29
    // minutes idle works for a minute in silence and is signed out mid-sentence.
    lastBeat.current = 0;
    reportedIdle.current = false;
    warningUp.current = false;

    // `passive` throughout: none of these prevent default, and a non-passive
    // scroll listener on a long ticket timeline is visible jank.
    for (const event of INPUT_EVENTS) {
      window.addEventListener(event, noteInput, { passive: true });
    }
    // Scroll is the exception, and it has to be captured on the document: the
    // event does not bubble, and this console has no document scroller at all —
    // the shell is `h-dvh overflow-hidden` and every list is its own
    // `overflow-y-auto` box, so a window listener would never fire once.
    document.addEventListener('scroll', noteInput, { capture: true, passive: true });
    // Turning back to the tab is a person doing something, the same as a click.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') noteInput();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', noteInput);

    const tick = setInterval(() => {
      const idleFor = Date.now() - lastInput.current;

      if (signoutMs !== null && idleFor >= signoutMs) {
        signOut();
        return;
      }

      if (signoutMs !== null && idleFor >= signoutMs - warningLeadMs && !warningUp.current) {
        // Both in one commit. Leaving `remainingMs` at its initial 0 until the
        // effect below runs paints "you will be signed out in 0 seconds" and
        // then counts *up* to 60, which is exactly the "reads as broken" the
        // countdown exists to avoid.
        warningUp.current = true;
        setWarning(true);
        setRemainingMs(Math.max(0, signoutMs - idleFor));
      }

      if (awayMs !== null && idleFor >= awayMs && !reportedIdle.current) {
        reportedIdle.current = true;
        void beat(true);
      }
    }, TICK_MS);

    return () => {
      clearInterval(tick);
      for (const event of INPUT_EVENTS) window.removeEventListener(event, noteInput);
      document.removeEventListener('scroll', noteInput, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', noteInput);
    };
  }, [active, awayMs, signoutMs, warningLeadMs, beat, noteInput, signOut]);

  // A second, faster timer, and only while the dialog is up: a countdown that
  // moves in five-second jumps reads as broken, and running at this rate all day
  // to serve the last minute of it would wake the tab 720 times an hour.
  useEffect(() => {
    if (!warning || signoutMs === null) return;

    const update = () => {
      setRemainingMs(Math.max(0, signoutMs - (Date.now() - lastInput.current)));
    };

    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [warning, signoutMs]);

  if (!warning) return null;

  const seconds = Math.ceil(remainingMs / 1000);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-warning-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-lg">
        <h2 id="idle-warning-title" className="text-sm font-semibold">
          Still there?
        </h2>
        <p aria-live="polite" className="mt-2 text-sm text-[var(--muted-foreground)]">
          You have been inactive, so you will be signed out in {seconds}{' '}
          {seconds === 1 ? 'second' : 'seconds'}. Anything you have typed and not sent will be lost.
        </p>
        <div className="mt-4 flex gap-2">
          <Button type="button" onClick={noteInput}>
            Stay signed in
          </Button>
          <Button type="button" variant="secondary" onClick={signOut}>
            Sign out now
          </Button>
        </div>
      </div>
    </div>
  );
}
