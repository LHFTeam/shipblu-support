'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClockIcon } from '@/components/icons';
import { Button } from '@/components/ui';
import { idleTick } from '@/lib/presence/idle';

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
 * The first and the third are measured from **different moments**, and that is
 * the correction rather than an inconsistency. Idleness is a fact about the
 * person, so the away report counts from the last key. The sign-out is a fact
 * about the session, and the server decides it from the last beat it was *told*
 * about — which the throttle above puts up to a minute behind the last key. A
 * countdown run off the key rather than off the beat is a countdown up to a
 * whole minute later than the server's, and the warning is only a minute long:
 * "Stay signed in" would reach a session the server had already destroyed, and
 * the reply in the box would be gone with the neutral "your session has ended"
 * on screen. So the third clock is the server's: anchored from what it says this
 * session's idleness is — on this render and on every one after it — and
 * advanced in between only by a beat it accepted.
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

/** 0:58 rather than "58 seconds": the title is read at a glance, not as a sentence. */
function mmss(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function AgentActivity({
  accepting,
  awayAfterMins,
  signoutAfterMins,
  sessionIdleForMs,
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
  /**
   * How idle the server currently thinks this session is, in milliseconds — a
   * duration rather than an instant so the two clocks need not agree. It is what
   * the countdown starts from on a page this tab has just loaded, which is the
   * case a mount-time reset gets wrong: reload a session that is already 29
   * minutes idle and a browser starting its own clock at zero shows nothing at
   * all until the sign-out lands.
   */
  sessionIdleForMs: number;
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
  /**
   * This clock's version of the moment the server's session clock stands at.
   *
   * Every sign-out decision below is measured from here rather than from
   * `lastInput`, so the browser can never be counting down to a later deadline
   * than the one `getSessionAgent()` is about to enforce.
   *
   * Two things move it, and both are evidence rather than assumption: a beat the
   * server accepted, and a fresh render — every console navigation re-reads the
   * session, so the prop arriving is the server's current answer. `Math.max`
   * because it may only ever go forwards: an RSC payload that was rendered
   * before the last beat landed is stale, and letting it drag the anchor
   * backwards would put a countdown on screen in front of somebody who is
   * demonstrably typing.
   *
   * Zero until the effect below runs, which is safe because nothing reads it
   * before then — the tick interval is started by that same effect — and
   * because `Date.now()` may not be called while rendering.
   */
  const reportedAt = useRef(0);
  useEffect(() => {
    reportedAt.current = Math.max(reportedAt.current, Date.now() - sessionIdleForMs);
  }, [sessionIdleForMs]);

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
  /**
   * The countdown's own element, so the listeners below can tell input *in*
   * the dialog from input anywhere else. A press on "Sign out now" reaches the
   * window's `pointerdown` listener before the button's `click` fires, and
   * read as activity it dismissed the countdown and kept the session — so the
   * button could not sign anyone out, and Enter on it went the same way through
   * `keydown`. Answering the dialog is not the agent coming back.
   */
  const dialog = useRef<HTMLDivElement>(null);

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
      // Taken before the request rather than after it. The server writes
      // `last_activity_at` when the beat lands, which is at or after this, so
      // anchoring here can only make the browser's deadline earlier than the
      // server's — the safe direction, and the one that keeps the warning a
      // warning rather than a race.
      const sentAt = Date.now();

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

        // Only an accepted beat moves the session clock, and only the input
        // kind: the idle report deliberately does not call
        // `touchSessionActivity`, so treating it as one would have a tab that
        // announced nobody is here quietly buy itself another full window.
        if (!idle) reportedAt.current = Math.max(reportedAt.current, sentAt);

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

    // The away clock starts at the mount. A page load is not input and does not
    // move the *session* clock — `reportedAt` keeps whatever the server said —
    // but somebody who has just navigated is plainly at their desk, so counting
    // them towards an away they are not in would park them for nothing.
    lastInput.current = Date.now();
    // Zero, not now: a page load is not itself input — a tab restored by the
    // browser at startup would otherwise refresh the clock with nobody there —
    // but the *first* thing the agent does has to reach the server immediately,
    // which on a session that is already most of the way to its deadline is the
    // one beat standing between them and being signed out mid-sentence.
    lastBeat.current = 0;
    reportedIdle.current = false;
    warningUp.current = false;

    // The input listeners come through here rather than straight into
    // `noteInput`, because each carries a target that can sit inside the
    // countdown: an event there is the agent answering the dialog, and the
    // dialog's buttons say what that answer is — the window must not decide it
    // first (see `dialog` above). `noteInput` itself stays the explicit signal:
    // "Stay signed in" and the tab becoming visible call it directly. The
    // `instanceof` is for the window's own `focus`, whose target is the window
    // and not a node; asking the dialog about it would throw.
    const onInput = (event: Event) => {
      if (event.target instanceof Node && dialog.current?.contains(event.target)) return;
      noteInput();
    };

    // `passive` throughout: none of these prevent default, and a non-passive
    // scroll listener on a long ticket timeline is visible jank.
    for (const event of INPUT_EVENTS) {
      window.addEventListener(event, onInput, { passive: true });
    }
    // Scroll is the exception, and it has to be captured on the document: the
    // event does not bubble, and this console has no document scroller at all —
    // the shell is `h-dvh overflow-hidden` and every list is its own
    // `overflow-y-auto` box, so a window listener would never fire once.
    document.addEventListener('scroll', onInput, { capture: true, passive: true });
    // Turning back to the tab is a person doing something, the same as a click.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') noteInput();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onInput);

    const tick = setInterval(() => {
      const now = Date.now();
      // Both clocks handed over together; `idleTick` owns which one answers
      // which question, and has the test that says so.
      const action = idleTick(
        { sessionMs: now - reportedAt.current, inputMs: now - lastInput.current },
        { signoutMs, awayMs, warningLeadMs },
      );

      if (action.signOut) {
        signOut();
        return;
      }

      if (action.warn && !warningUp.current) {
        // Both in one commit. Leaving `remainingMs` at its initial 0 until the
        // effect below runs paints "you will be signed out in 0 seconds" and
        // then counts *up* to 60, which is exactly the "reads as broken" the
        // countdown exists to avoid.
        warningUp.current = true;
        setWarning(true);
        setRemainingMs(action.remainingMs);
      }

      if (action.reportIdle && !reportedIdle.current) {
        reportedIdle.current = true;
        void beat(true);
      }
    }, TICK_MS);

    return () => {
      clearInterval(tick);
      for (const event of INPUT_EVENTS) window.removeEventListener(event, onInput);
      document.removeEventListener('scroll', onInput, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onInput);
    };
  }, [active, awayMs, signoutMs, warningLeadMs, beat, noteInput, signOut]);

  // A second, faster timer, and only while the dialog is up: a countdown that
  // moves in five-second jumps reads as broken, and running at this rate all day
  // to serve the last minute of it would wake the tab 720 times an hour.
  useEffect(() => {
    if (!warning || signoutMs === null) return;

    const update = () => {
      setRemainingMs(Math.max(0, signoutMs - (Date.now() - reportedAt.current)));
    };

    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [warning, signoutMs]);

  if (!warning) return null;

  const seconds = Math.ceil(remainingMs / 1000);

  return (
    <div className="fixed inset-0 z-60 flex items-start justify-center bg-black/30 p-4 pt-[18vh]">
      <div
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-warning-title"
        aria-describedby="idle-warning-desc"
        className="flex w-full max-w-[360px] flex-col gap-3 rounded-xl bg-(--color-background-surface) p-5 shadow-overlay"
      >
        <div className="flex items-start gap-2.5">
          <ClockIcon size={20} className="shrink-0 text-(--color-attention-bg)" />
          <div>
            <h2 id="idle-warning-title" aria-live="polite" className="text-sm font-semibold">
              Signing you out in <span className="tabular-nums">{mmss(seconds)}</span>
            </h2>
            <p id="idle-warning-desc" className="mt-0.5 text-xs text-(--color-text-secondary)">
              You have been inactive. Anything you have typed and not sent will be lost.
            </p>
          </div>
        </div>
        {/* No `autoFocus` on "Stay signed in", although a dialog would usually
            take it. Any key pressed *outside* this dialog dismisses it through
            `noteInput` — a key inside it is the agent answering the dialog and
            is not counted — so a focused button would swallow the returning
            agent's first keystroke, leave focus on the button instead of in the
            reply they were typing, and not even dismiss the countdown. The
            buttons are the only input in here that means anything, and each
            says what it means directly: `noteInput` called by hand is the
            explicit "I am here", where the listeners above would have read the
            press that reached "Sign out now" as the same thing. */}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={signOut}>
            Sign out now
          </Button>
          <Button onClick={() => noteInput()}>Stay signed in</Button>
        </div>
      </div>
    </div>
  );
}
