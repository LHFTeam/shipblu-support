'use client';

import {
  useActionState,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { unstable_rethrow, useRouter } from 'next/navigation';
import { SubmitButton } from '@/components/submit-button';
import { useRefreshOnSuccess } from '@/components/use-refresh-on-success';
import { InfoTip } from '@/components/tooltip';
import { Badge, Button, Card, ErrorText, Field, Select, SuccessText } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { RefreshScheduler } from '@/lib/realtime/refresh-scheduler';
import {
  type Coexistence,
  coexistenceBadges,
  historyProgress,
  parseCoexistence,
  type SyncType,
} from '@/lib/whatsapp/coexistence';
import {
  type CredentialBadge,
  credentialBadges,
  type CredentialStatus,
} from '@/lib/whatsapp/credential-status';
import {
  type ConnectPhase,
  connectWaitingOn,
  createSdkGate,
  embeddedSignupLoginOptions,
  FB_SDK_URL,
  FINISH_WAIT_MS,
  isFacebookOrigin,
  parseSignupMessage,
  POPUP_BLOCKED_MS,
  reduceConnectPhase,
  SDK_LOAD_TIMEOUT_MS,
  type SignupMessage,
  signupStepLabel,
  watchWindowOpen,
} from '@/lib/whatsapp/embedded-signup';
import {
  connectedFollowUps,
  describeOnboarding,
  type OnboardingView,
  phoneRepliesUnconfirmed,
  pollIntervalMs,
  recoveryFor,
} from '@/lib/whatsapp/onboarding-view';
import { DangerAction } from '../forms-shared';
import type { AdminState } from '../settings-shared';
import {
  connectBusinessAppNumber,
  forgetStoredCredential,
  requestCoexistenceSync,
  retryCoexistenceOnboarding,
} from './actions';

/**
 * Connecting a number that lives on the WhatsApp Business app, from the
 * channels page: the card that opens Meta's window, the card that follows the
 * job connecting it, and the badges and buttons the rows carry afterwards.
 *
 * Everything here is drawn from pure modules the server also uses —
 * `coexistenceBadges`, `credentialBadges`, `describeOnboarding` — so the row
 * and the job cannot disagree about what a connection is doing. This file
 * imports nothing that reaches the database (`client-bundle` walks it); the
 * page reads the rows and hands plain views down.
 *
 * The one piece of real machinery is the connect card's phase machine. Meta's
 * window talks to the page two ways at once — `FB.login`'s callback brings the
 * sign-in code, a `postMessage` brings the ids — in either order, and the code
 * lives thirty seconds. So both land in refs, whichever arrives second calls
 * the action, and a `useReducer` holds which of the plan's states the card is
 * in so every one of them has its sentence.
 */

type Choice = { id: string; name: string };

/** `coexistenceReadiness()`'s answer, as the page hands it over. */
export type ConnectReadiness =
  | { ready: true; appId: string; configId: string }
  | { ready: false; missing: { variable: string; why: string }[] };

const INITIAL: AdminState = { error: null };

// --- Meta's SDK -------------------------------------------------------------

type FacebookSdk = {
  init(options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
    options: ReturnType<typeof embeddedSignupLoginOptions>,
  ): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_SCRIPT_ID = 'facebook-jssdk';

/**
 * The document's one `fbAsyncInit`, shared by every connect card on the page
 * (`createSdkGate` says why one per card loses). Module scope, like the script
 * tag it stands for: a card closed and reopened finds the SDK initialised and
 * does not wait for a call that will not come. Touches no browser global until
 * a card mounts, so the server render can import it.
 */
const sdk = createSdkGate();

// --- The connect card's phases ----------------------------------------------
// The machine itself is `reduceConnectPhase` in `lib/whatsapp/embedded-signup`,
// where the test beside it runs; what is here is what the admin reads.

/** The plan's copy for each phase. `idle` with no error says nothing. */
function phaseCopy(
  phase: ConnectPhase,
): { text: string; tone: 'muted' | 'error' | 'success' } | null {
  switch (phase.name) {
    case 'loading_sdk':
      return { text: "Loading Meta's sign-in…", tone: 'muted' };
    case 'sdk_blocked':
      // Split by cause, because only one of them is a diagnosis: the script's
      // `error` event means it will not arrive, while the timeout only means it
      // has not yet — and the card carries on by itself if it does.
      return phase.cause === 'error'
        ? {
            text:
              "Meta's sign-in script could not be loaded — usually a content blocker. Allow " +
              'connect.facebook.net for this page and reload.',
            tone: 'error',
          }
        : {
            text:
              "Meta's sign-in has not loaded after ten seconds. A content blocker on " +
              'connect.facebook.net is the usual cause — allow it for this page and reload. On a ' +
              'slow connection, wait instead: this card carries on by itself when it arrives.',
            tone: 'error',
          };
    case 'idle':
      return phase.error ? { text: phase.error, tone: 'error' } : null;
    case 'popup_open':
      return {
        text:
          "Meta's window is open. Finish the steps there — this page updates when you do." +
          // The SDK opened nothing during the click, so the card cannot tell a
          // window opened some other way from one the browser stopped.
          (phase.unseen
            ? ' No window? Your browser may have blocked it: allow pop-ups for this site, then ' +
              'close this card (Cancel, then Close anyway) and open it again.'
            : ''),
        tone: 'muted',
      };
    case 'popup_blocked':
      return {
        text: 'Your browser blocked the window. Allow pop-ups for this site and press Try again.',
        tone: 'error',
      };
    case 'cancelled':
      return {
        text: phase.step
          ? `You closed Meta's window at the ${signupStepLabel(phase.step)} step. Nothing was changed.`
          : "You closed Meta's window. Nothing was changed.",
        tone: 'muted',
      };
    case 'meta_error':
      return {
        text:
          `Meta reported: ${phase.message ?? 'an error with no message'}.` +
          (phase.sessionId ? ` Reference ${phase.sessionId} — quote it to Meta support.` : ''),
        tone: 'error',
      };
    case 'awaiting_number':
      return { text: 'Reading which number you chose…', tone: 'muted' };
    case 'no_number':
      return {
        text:
          'Meta signed you in but did not say which number was chosen — the flow ended without ' +
          'a number set up. Try again and complete the number step.',
        tone: 'error',
      };
    case 'finishing':
      return { text: 'Verifying with Meta…', tone: 'muted' };
    case 'unanswered':
      return {
        text:
          'No answer came back. The progress below shows whether the number was connected; if ' +
          'it was, nothing is lost.',
        tone: 'error',
      };
    case 'done':
      return { text: phase.notice, tone: 'success' };
  }
}

/** The phases from which pressing the button again is the recovery. */
const RETRYABLE = new Set<ConnectPhase['name']>([
  'popup_blocked',
  'cancelled',
  'meta_error',
  'no_number',
  'unanswered',
]);

/**
 * "Connect a WhatsApp number": the card that opens Meta's window, or — in
 * `reconnect` mode, on a row that already has one — a small button that
 * expands the same card in place.
 *
 * Not `Disclosure`, because its button is always the secondary style and this
 * is the page's primary action in one mode and a row's quiet one in the other;
 * the card itself takes `Disclosure`'s `data-expanded` shape so the page header
 * gives it the whole row.
 *
 * Cancel asks first while the card is waiting on Meta. Closing the card
 * unmounts the `message` listener and the refs the answer lands in, but not
 * Meta's window: the business would finish the steps there — and Meta would
 * unlink the phone's linked devices — for an answer nobody hears. Asked rather
 * than refused, so a login callback that never came cannot pin the card open
 * until a reload. `onBusyChange` tells a row the same thing, so it can keep its
 * own controls from replacing the card mid-flow.
 *
 * Focus follows the swap between the button and the card, because each
 * replaces the other: opening moves it to the card's heading, and closing
 * returns it to the button, which would otherwise leave a keyboard or screen
 * reader user on a node that no longer exists — at the top of the document.
 */
export function ConnectBusinessAppNumber({
  readiness,
  groups,
  suggestedGroupId,
  mode,
  onBusyChange,
}: {
  readiness: ConnectReadiness;
  groups: Choice[];
  /** The one existing WhatsApp channel's group, when there is exactly one. */
  suggestedGroupId: string | null;
  mode: 'connect' | 'reconnect';
  /** Told whenever the card starts or stops waiting on Meta's window or its answer. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [waitingOn, setWaitingOn] = useState<'window' | 'verifying' | null>(null);
  const [armed, setArmed] = useState(false);
  const label = mode === 'reconnect' ? 'Reconnect' : 'Connect a WhatsApp number';
  const busy = waitingOn !== null;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set by the click that opens or closes the card and spent once the swap has
  // rendered, because the element to focus does not exist until then — and so
  // that a first render, or one caused by anything else, moves nothing.
  const focusAfterSwap = useRef<'heading' | 'trigger' | null>(null);
  useEffect(() => {
    const target = focusAfterSwap.current;
    focusAfterSwap.current = null;
    if (target === 'heading') headingRef.current?.focus();
    else if (target === 'trigger') triggerRef.current?.focus();
  }, [open]);

  // Stable, so the card's effect reporting through it runs only when the
  // answer changes. A wait that ends disarms the Cancel: the next one asks
  // again rather than closing on a click made about the last.
  const reportWaiting = useCallback((next: 'window' | 'verifying' | null) => {
    setWaitingOn(next);
    if (next === null) setArmed(false);
  }, []);

  // The cleanup reports idle, so a card unmounted mid-wait by something else
  // does not leave its row's controls off until a reload.
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  function openCard() {
    focusAfterSwap.current = 'heading';
    setOpen(true);
  }

  function close() {
    focusAfterSwap.current = 'trigger';
    setOpen(false);
    setWaitingOn(null);
    setArmed(false);
  }

  if (!open) {
    return mode === 'reconnect' ? (
      <Button ref={triggerRef} variant="ghost" size="sm" onClick={openCard}>
        {label}
      </Button>
    ) : (
      <Button ref={triggerRef} onClick={openCard}>
        {label}
      </Button>
    );
  }

  return (
    <Card data-expanded className="w-full border-brand-500/30">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 ref={headingRef} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
          {label}
        </h2>
        <button
          type="button"
          onClick={() => (busy && !armed ? setArmed(true) : close())}
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          {busy && armed ? 'Close anyway' : 'Cancel'}
        </button>
      </div>
      {busy && armed ? (
        <p className="mb-3 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
          {waitingOn === 'window' ? (
            <>
              Meta&rsquo;s window is still open, and this card is what hears its answer. Close the
              window first and this card says what happened. Closing the card now loses the answer,
              so steps finished in the window would have to be done again.
            </>
          ) : (
            <>
              This card is checking Meta&rsquo;s answer, which takes a few seconds. Closing it now
              hides the reason if the number is refused; a connection that goes through still
              appears on this page.
            </>
          )}
        </p>
      ) : null}
      {readiness.ready ? (
        <ConnectCard
          readiness={readiness}
          groups={groups}
          suggestedGroupId={suggestedGroupId}
          mode={mode}
          onWaitingChange={reportWaiting}
        />
      ) : (
        <NotReady missing={readiness.missing} />
      )}
    </Card>
  );
}

/**
 * The checklist of missing variables, with the button disabled. Every one of
 * them belongs in this environment's own group, so the paragraph names the
 * group once rather than per variable.
 */
function NotReady({ missing }: { missing: { variable: string; why: string }[] }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      {/* Both groups, each with its own value — and a redeploy, not a reload:
          `env()` reads the environment once per process, and production does
          not redeploy itself when a group changes. The worker is named because
          it opens the sealed credential with the same key; a web service
          redeployed alone turns this card ready while the job that follows
          fails. */}
      <p className="text-[var(--muted-foreground)]">
        This environment cannot open Meta&rsquo;s sign-in yet. Set these on Render in this
        environment&rsquo;s own group — <code>shipblu-support-production</code> on production,
        <code> shipblu-support-staging</code> on staging, each with its own value — not in{' '}
        <code>shipblu-support-shared</code> and not on a service. Then deploy the web service and
        the worker; this list updates once the new deploy is live.
      </p>
      <ul className="flex flex-col gap-1.5">
        {missing.map((setting) => (
          <li key={setting.variable} className="flex flex-wrap gap-x-2 text-xs">
            <code className="font-medium">{setting.variable}</code>
            <span className="text-[var(--muted-foreground)]">{setting.why}</span>
          </li>
        ))}
      </ul>
      <Button disabled className="self-start">
        Continue with Meta
      </Button>
    </div>
  );
}

function ConnectCard({
  readiness,
  groups,
  suggestedGroupId,
  mode,
  onWaitingChange,
}: {
  readiness: { ready: true; appId: string; configId: string };
  groups: Choice[];
  suggestedGroupId: string | null;
  mode: 'connect' | 'reconnect';
  onWaitingChange: (waitingOn: 'window' | 'verifying' | null) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [phase, dispatch] = useReducer(reduceConnectPhase, {
    name: 'loading_sdk',
  } as ConnectPhase);

  // Whether Meta's window may still answer: set when it opens, cleared once
  // `FB.login`'s callback has fired and any code it handed over is spent or
  // dropped. The phase alone cannot say it — an ERROR or a CANCEL leaves the
  // window open and still able to finish (`connectWaitingOn`).
  const [answerDue, setAnswerDue] = useState(false);
  const waitingOn = connectWaitingOn(phase, answerDue);
  useEffect(() => {
    onWaitingChange(waitingOn);
  }, [waitingOn, onWaitingChange]);

  // Outside any <form>, so there is nothing a reset could move and nothing
  // for Enter to submit; the action is called with a FormData built by hand.
  const [groupId, setGroupId] = useState(suggestedGroupId ?? '');

  // The two halves of Meta's answer. Refs rather than state because the code
  // must never be rendered — it is a credential for thirty seconds — and
  // because whichever half arrives second has to read the first synchronously.
  const codeRef = useRef<string | null>(null);
  const finishRef = useRef<Extract<SignupMessage, { kind: 'finished' }> | null>(null);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { appId, configId } = readiness;

  // The SDK is injected when the card opens, never on the click: `FB.login`
  // has to run synchronously inside the click or the browser treats the
  // window as a pop-up and blocks it, so the script has to be there already.
  // The `app/help/chat.tsx` shape: one tag per document, a 'load' that may
  // land after the reader has left, an 'error' that takes the tag down so a
  // reload can try again. The wait goes through the shared gate, so a second
  // card open while the script downloads is woken by the same load.
  //
  // The timeout says "blocked" but does not unsubscribe: it is a guess, and a
  // script that arrives after it still wakes this card (`reduceConnectPhase`
  // lets `sdk_ready` lift it).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stopWaiting = sdk.wait(window, appId, {
      ready: () => {
        if (timer) clearTimeout(timer);
        dispatch({ type: 'sdk_ready' });
      },
      blocked: () => {
        if (timer) clearTimeout(timer);
        dispatch({ type: 'sdk_blocked', cause: 'error' });
      },
    });
    if (sdk.initialised) return stopWaiting;

    timer = setTimeout(
      () => dispatch({ type: 'sdk_blocked', cause: 'timeout' }),
      SDK_LOAD_TIMEOUT_MS,
    );

    if (!document.getElementById(SDK_SCRIPT_ID)) {
      const script = document.createElement('script');
      script.id = SDK_SCRIPT_ID;
      script.src = FB_SDK_URL;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.addEventListener('error', () => {
        script.remove();
        sdk.fail();
      });
      document.body.appendChild(script);
    }

    return () => {
      stopWaiting();
      if (timer) clearTimeout(timer);
    };
  }, [appId]);

  /**
   * Calls the action once both halves are in hand — the code from the login
   * callback, the ids from the finish message — and waits a moment for the
   * second when only the first has arrived.
   *
   * The action is called directly, inside a transition, rather than through a
   * hidden `<form>` and `useActionForm`: the hook exists to keep a form's
   * fields through a refusal, and this card has no fields — a hidden form
   * would put the code into an input's value, and its answer would have to be
   * read back out of the hook's state by an effect to learn which phase the
   * card is in. One round trip, whose answer lands straight in the reducer.
   * The `try`/`catch` is the hook's own guard, kept: an action that throws —
   * the connection dropped — becomes `unanswered` rather than `global-error`,
   * and the page is re-read so the progress card can say what happened.
   */
  const tryFinish = useCallback(() => {
    const code = codeRef.current;
    const finish = finishRef.current;

    if (!code || !finish) {
      if (code && !finish) {
        dispatch({ type: 'awaiting_number' });
        if (finishTimer.current) clearTimeout(finishTimer.current);
        finishTimer.current = setTimeout(() => {
          // The code is dropped with the wait: a finish message landing
          // after this would otherwise call the action from a card that
          // has already said the flow ended without a number.
          codeRef.current = null;
          setAnswerDue(false);
          dispatch({ type: 'no_number' });
        }, FINISH_WAIT_MS);
      }
      return;
    }

    if (finishTimer.current) clearTimeout(finishTimer.current);
    finishTimer.current = null;
    // Spent: a second finish message, or a retry, starts from nothing.
    codeRef.current = null;
    finishRef.current = null;
    setAnswerDue(false);

    const formData = new FormData();
    formData.set('code', code);
    formData.set('wabaId', finish.wabaId);
    formData.set('phoneNumberId', finish.phoneNumberId ?? '');
    formData.set('defaultGroupId', groupId);

    dispatch({ type: 'finishing' });
    startTransition(async () => {
      try {
        const result = await connectBusinessAppNumber(INITIAL, formData);
        if (result.ok) {
          dispatch({ type: 'done', notice: result.notice ?? 'Connecting the number now.' });
          router.refresh();
        } else {
          // `wait` marks a refusal that running Meta's window again cannot fix
          // — the rate limit, or an attempt on this number still live — read
          // off the answer rather than out of its wording. Each run of the
          // window unlinks the phone's linked devices again, so the card stops
          // offering one; a live attempt is the progress card the sentence
          // points at, so the page is re-read to put it there.
          const wait = result.wait === true;
          dispatch({
            type: 'refused',
            error: result.error ?? "Meta's window did not connect the number.",
            wait,
          });
          if (wait) router.refresh();
        }
      } catch (error) {
        unstable_rethrow(error);
        dispatch({ type: 'unanswered' });
        router.refresh();
      }
    });
  }, [router, groupId]);

  // Meta's window posts to the opener. Only its origin counts, parsed as a
  // hostname (`isFacebookOrigin` says why), and nothing here throws: this
  // hears every message any script on the page posts.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isFacebookOrigin(event.origin)) return;
      const message = parseSignupMessage(event.data);
      if (!message) return;
      switch (message.kind) {
        case 'finished':
          finishRef.current = message;
          tryFinish();
          break;
        case 'cancelled':
          dispatch({ type: 'cancelled', step: message.step });
          break;
        case 'error':
          dispatch({ type: 'meta_error', message: message.message, sessionId: message.sessionId });
          break;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [tryFinish]);

  useEffect(
    () => () => {
      if (finishTimer.current) clearTimeout(finishTimer.current);
    },
    [],
  );

  /** Synchronous in the click, for the pop-up blocker's sake. */
  function connect() {
    const fb = window.FB;
    if (!fb) return;

    codeRef.current = null;
    finishRef.current = null;
    if (finishTimer.current) clearTimeout(finishTimer.current);
    finishTimer.current = null;
    const clickedAt = Date.now();
    setAnswerDue(true);
    dispatch({ type: 'opened' });

    // The SDK never calls back for a window the browser refused, so the
    // refusal is read off `window.open` while `FB.login` runs — the only place
    // it shows (`watchWindowOpen`). Without this the card sat on "Meta's
    // window is open" for good, with no window and nothing to press.
    const opened = watchWindowOpen(window, () => {
      fb.login((response) => {
        const code = response?.authResponse?.code;
        if (code) {
          codeRef.current = code;
          tryFinish();
          return;
        }
        // No code, so nothing more can come of this window.
        setAnswerDue(false);
        // No code: a window that opened has shut — the SDK's monitor saw it
        // close, or the flow ended without a code. Meta's CANCEL or ERROR
        // usually lands around now, so it is given a moment to name the step
        // before the card calls it a plain close.
        if (finishRef.current) {
          // Finished, and no code to exchange: the login configuration is not
          // returning one — a misconfiguration, not something to retry blindly.
          dispatch({
            type: 'meta_error',
            message:
              "the window finished without a sign-in code — check the login configuration's response type",
            sessionId: null,
          });
          return;
        }
        // Shut within a second of opening: a blocker extension closing what
        // `window.open` gave it, or a very fast cancel (`POPUP_BLOCKED_MS`).
        if (Date.now() - clickedAt < POPUP_BLOCKED_MS) {
          dispatch({ type: 'popup_blocked' });
          return;
        }
        setTimeout(() => dispatch({ type: 'closed' }), 300);
      }, embeddedSignupLoginOptions(configId));
    });
    if (opened === 'blocked') dispatch({ type: 'popup_blocked' });
    else if (opened === 'not_called') dispatch({ type: 'window_unseen' });
  }

  const copy = phaseCopy(phase);
  const busy = waitingOn !== null;
  // A refusal marked `wait` keeps the button off: the next run of Meta's
  // window would end the same way. Closing and reopening the card is the way
  // back once the sentence's wait is over, which the line under it says.
  const mustWait = phase.name === 'idle' && phase.wait;
  const buttonLabel =
    phase.name === 'loading_sdk'
      ? "Loading Meta's sign-in…"
      : RETRYABLE.has(phase.name) || (phase.name === 'idle' && phase.error && !mustWait)
        ? 'Try again'
        : 'Continue with Meta';
  const canPress = (phase.name === 'idle' && !mustWait) || RETRYABLE.has(phase.name);
  // What is announced: the muted and success lines, which `ErrorText`'s
  // `role="alert"` does not cover.
  const status = copy && copy.tone !== 'error' ? copy.text : '';

  return (
    // Positioned for the `sr-only` live region below, which is
    // `position: absolute` and would otherwise be placed against the document
    // (PROJECT-STATE §6.81).
    <div className="relative flex flex-col gap-3 text-sm">
      <ul className="flex flex-col gap-1 text-xs text-[var(--muted-foreground)]">
        <li>Sign in as an admin of the Business portfolio that owns the number.</li>
        <li>
          Keep the WhatsApp Business app open on the phone until the chat history finishes copying —
          six months of chats can take hours.
        </li>
        <li>
          Meta unlinks the number&rsquo;s linked devices when it connects
          {mode === 'reconnect' ? '; reconnecting does this again.' : '.'}
        </li>
      </ul>

      <Field
        label="Default group"
        className="sm:w-56"
        hint={
          mode === 'reconnect'
            ? 'A reconnected number keeps its channel and its group; this is used only if the window connects a different number.'
            : 'Where tickets from this number start. Changeable on the channel afterwards.'
        }
      >
        <Select
          value={groupId}
          onChange={(event) => setGroupId(event.target.value)}
          disabled={busy}
        >
          <option value="">None</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </Select>
      </Field>

      {copy?.tone === 'error' ? <ErrorText>{copy.text}</ErrorText> : null}
      {mustWait ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          The button stays off until this card is closed and opened again: running Meta&rsquo;s
          window now would end the same way, and it unlinks the phone&rsquo;s linked devices each
          time.
        </p>
      ) : null}
      {/* Announced through one region mounted for the card's whole life: a
          `role="status"` inserted together with its text is not reliably read
          out, and these are the lines that say whether anything happened.
          The visible copy is hidden from assistive technology so it is not
          read twice. Errors stay outside, in `ErrorText`'s alert. */}
      <p role="status" className="sr-only">
        {status}
      </p>
      {copy?.tone === 'success' ? (
        <div aria-hidden>
          <SuccessText>{copy.text}</SuccessText>
        </div>
      ) : null}
      {copy?.tone === 'muted' ? (
        <p aria-hidden className="text-xs text-[var(--muted-foreground)]">
          {copy.text}
        </p>
      ) : null}

      {phase.name === 'done' ? null : (
        <Button onClick={connect} disabled={!canPress} className="self-start">
          {buttonLabel}
        </Button>
      )}
    </div>
  );
}

// --- Progress ---------------------------------------------------------------

/**
 * Re-reads the page every `intervalMs`, single-flight and only while the tab
 * is visible — `LiveUpdates`' scheduler on a timer instead of a stream, for
 * the reason the plan gives: an admin topic on `/api/events` would hold one
 * more backend connection per admin tab for an audience of one person
 * watching six states. Null stops it.
 */
function useRefreshEvery(intervalMs: number | null) {
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
    if (intervalMs === null) return;

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
    const poll = setInterval(() => scheduler.request(), intervalMs);

    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      scheduler.dispose();
      schedulerRef.current = null;
      observedPendingRef.current = false;
    };
  }, [intervalMs, router, startTransition]);
}

const STEP_GLYPH = { pending: '◌', running: '…', done: '✓', failed: '✗' } as const;

/**
 * One attempt, as the page polls it: each step as it lands, the queue's
 * backoff, the stall sentence, the recovery, and the summary once it connected.
 *
 * The recovery is two controls, because a failure is one of two kinds and the
 * card cannot tell which from the sentence. Retry runs the job again with the
 * stored credential and no popup — right for anything fixed outside the job (a
 * permission granted, `META_APP_ID` set, a worker that gave up). A new sign-in
 * is right for what the job cannot fix — the wrong number chosen in Meta's
 * window, a credential since forgotten — and is offered beside it, from the
 * `connect` the page hands over. `recoveryFor` decides which apply.
 */
export function OnboardingProgress({
  onboarding,
  coexistence,
  channelName,
  accountName,
  credential,
  canConnect,
  connect,
  now,
}: {
  onboarding: OnboardingView;
  coexistence: Coexistence | null;
  channelName: string | null;
  accountName: string | null;
  credential: CredentialStatus | null;
  canConnect: boolean;
  /**
   * What the connect card needs, so a failed attempt can offer a new sign-in in
   * place. Required, so the one recovery the job cannot provide is not lost to
   * a call site that leaves it out.
   */
  connect: { readiness: ConnectReadiness; groups: Choice[]; suggestedGroupId: string | null };
  /** The server's clock at render, so the page and this card agree on the sentences. */
  now: Date;
}) {
  // On the server's clock: every refresh renders a fresh `now`, and every
  // bound `pollIntervalMs` applies is measured against it, so a backoff, a
  // stall or a copy that has gone quiet changes the interval on the next read
  // without a clock of its own.
  useRefreshEvery(pollIntervalMs(onboarding, coexistence, now));

  // Retry is off while the sign-in beside it waits on Meta: a retry that starts
  // turns this attempt back to `exchanged`, which takes both recoveries off the
  // card — and unmounting the sign-in card unmounts the listener Meta's answer
  // arrives on while the window is still open.
  const [signingIn, setSigningIn] = useState(false);

  const lines = describeOnboarding(onboarding, now);
  const recovery = recoveryFor(onboarding, now, credential !== null);
  const number = coexistence?.displayPhoneNumber ?? onboarding.phoneNumberId;
  const title =
    onboarding.status === 'exchanged'
      ? `Connecting ${number}…`
      : onboarding.status === 'failed'
        ? `Connecting ${number} failed`
        : 'Connected.';

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs text-[var(--muted-foreground)]">
          started {formatDateTime(onboarding.startedAt)}
          {onboarding.startedByLabel ? ` by ${onboarding.startedByLabel}` : ''}
        </span>
      </div>

      <ol className="flex flex-col gap-1 text-sm">
        {onboarding.steps.map((step) => (
          <li key={step.step} className="flex flex-col">
            <span className="flex items-baseline gap-2">
              <span
                aria-hidden
                className={`w-4 text-center ${
                  step.state === 'failed'
                    ? 'text-red-600'
                    : step.state === 'done'
                      ? 'text-emerald-600'
                      : 'text-[var(--muted-foreground)]'
                }`}
              >
                {STEP_GLYPH[step.state]}
              </span>
              <span className="sr-only">{step.state}</span>
              <span className={step.state === 'pending' ? 'text-[var(--muted-foreground)]' : ''}>
                {step.label}
              </span>
            </span>
            {step.sentence ? (
              <span
                className={`ms-6 text-xs ${
                  step.state === 'failed' ? 'text-red-600' : 'text-[var(--muted-foreground)]'
                }`}
              >
                {step.sentence}
              </span>
            ) : null}
            {step.warning ? (
              <span className="ms-6 text-xs text-amber-600">{step.warning}</span>
            ) : null}
          </li>
        ))}
      </ol>

      {lines.map((line) => (
        <p key={line} className="text-xs text-amber-600">
          {line}
        </p>
      ))}

      {onboarding.status === 'failed' ? (
        <ErrorText>{onboarding.error ?? 'The connection failed.'}</ErrorText>
      ) : null}

      {canConnect && (recovery.retry || recovery.connect) ? (
        <div className="flex flex-wrap items-start gap-2">
          {recovery.retry ? (
            <RetryOnboarding onboardingId={onboarding.id} disabled={signingIn} />
          ) : null}
          {recovery.connect ? (
            // `reconnect` only where the attempt reached a channel: its hint
            // about the group being used "only if the window connects a
            // different number" is wrong for a number never connected.
            <ConnectBusinessAppNumber
              {...connect}
              mode={onboarding.channelId ? 'reconnect' : 'connect'}
              onBusyChange={setSigningIn}
            />
          ) : null}
        </div>
      ) : null}

      {onboarding.status === 'connected' ? (
        <ConnectedSummary
          onboarding={onboarding}
          coexistence={coexistence}
          channelName={channelName}
          accountName={accountName}
          credential={credential}
        />
      ) : null}
    </Card>
  );
}

/**
 * The plan's "Done" block, from what the connection knows about itself.
 *
 * Its closing line is built from the steps rather than fixed. "Nothing else to
 * do" under a subscribe warning saying phone replies will not arrive sent the
 * admin away from the one thing still to do — and the card, with the warning on
 * it, leaves the page after a day. So the phone-replies sentence is printed
 * only when the number and subscribe steps say nothing against it, and "Nothing
 * else to do" only when no step failed or asked for something and the
 * credential is stored. What Meta says about the number — not on the Business
 * app, another platform — is printed as a note and does not hold that line
 * back: nothing on this page changes it (`connectedFollowUps`).
 */
function ConnectedSummary({
  onboarding,
  coexistence,
  channelName,
  accountName,
  credential,
}: {
  onboarding: OnboardingView;
  coexistence: Coexistence | null;
  channelName: string | null;
  accountName: string | null;
  credential: CredentialStatus | null;
}) {
  const number = coexistence?.displayPhoneNumber ?? onboarding.phoneNumberId;
  const verified = coexistence?.verifiedName ? ` (${coexistence.verifiedName})` : '';
  const stored = credential
    ? `credential stored (${expiryLabel(credential)})`
    : 'credential not stored';

  const stepSentence = (step: 'contacts' | 'history') =>
    onboarding.steps.find((candidate) => candidate.step === step)?.sentence ?? 'not requested';

  // Entries, not people: an entry the phone re-sends or edits counts again
  // (`recordContactSync`), so the line says what the counter counts.
  const contacts = coexistence?.syncs.contacts;
  const received = contacts?.received ?? 0;
  const contactsLine =
    contacts && 'requestId' in contacts && contacts.requestId
      ? `Contacts: ${received} address-book entr${received === 1 ? 'y' : 'ies'} received.`
      : `Contacts: ${stepSentence('contacts')}`;

  // One overall figure, not one per phase: Meta's `progress` is the whole
  // copy's, and a phase with no chats never reports at all (`historyProgress`).
  const history = coexistence ? historyProgress(coexistence) : null;
  const historyLine = !history?.requested
    ? `History: ${stepSentence('history')}`
    : history.declined
      ? 'History: declined on the phone.'
      : `History: ${history.percent}% (${history.chunks} chunk${history.chunks === 1 ? '' : 's'}).`;

  const { todo, notes } = connectedFollowUps(onboarding);
  const allClear = todo.length === 0 && credential !== null;

  return (
    <div className="flex flex-col gap-1 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800">
      <p>
        <strong>Connected.</strong> {number}
        {verified} is live as channel &ldquo;{channelName ?? 'unnamed'}&rdquo; under business
        account &ldquo;{accountName ?? onboarding.wabaId}&rdquo; · {stored}.
      </p>
      <p>
        {contactsLine} {historyLine}
        {history?.requested && !history.done
          ? ' Keep the WhatsApp Business app open on the phone until this reaches 100% — six months of chats can take hours.'
          : ''}
      </p>
      {phoneRepliesUnconfirmed(onboarding) ? null : (
        <p>
          Replies typed on the phone appear on tickets as &ldquo;WhatsApp Business app&rdquo;.
          Console replies go out over Cloud API.
        </p>
      )}
      {/* Pointed at rather than repeated: the step above already prints the
          note in full, and a second copy here, in the success colour, read as
          a different message. A note is a fact about the number, not a task,
          so it does not stop "nothing else to do" being true. */}
      {notes.length > 0 ? (
        <p>
          See the note under{' '}
          {notes.map((item, index) => (
            <span key={`note-${item.step}`}>
              {index > 0 ? ', ' : ''}&ldquo;{item.label}&rdquo;
            </span>
          ))}{' '}
          above.
        </p>
      ) : null}
      {allClear ? (
        <p>Nothing else to do.</p>
      ) : (
        <div className="text-amber-800">
          {todo.length > 0 ? (
            <>
              <p>
                <strong>Still to do:</strong>
              </p>
              <ul className="list-disc ps-5">
                {todo.map((item) => (
                  <li key={`${item.step}-${item.kind}`}>
                    &ldquo;{item.label}&rdquo; — the {item.kind === 'warning' ? 'note' : 'reason'}{' '}
                    under it above says what is needed.
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {/* Not "press Reconnect": an account with no stored credential may
              still send with a token the environment names, which the account
              row shows. */}
          {credential === null ? (
            <p>
              No credential is stored for this business account now, so it sends with a token from
              the environment, if one is set — the account&rsquo;s row above names which.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** "Retry connection" — hidden field and a button, so a plain form action is right (§6.80). */
export function RetryOnboarding({
  onboardingId,
  disabled = false,
}: {
  onboardingId: string;
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(retryCoexistenceOnboarding, INITIAL);
  useRefreshOnSuccess(state);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="onboardingId" value={onboardingId} />
      <SubmitButton
        idle="Retry connection"
        busy="Starting…"
        variant="secondary"
        disabled={disabled}
      />
      <ErrorText>{state.error}</ErrorText>
      {state.notice ? (
        <span className="text-xs text-[var(--muted-foreground)]">{state.notice}</span>
      ) : null}
    </form>
  );
}

// --- Rows -------------------------------------------------------------------

/** The badges a connected channel's row carries, each with its explanation one tap away. */
export function CoexistenceBadges({ config, now }: { config: Record<string, unknown>; now: Date }) {
  const coexistence = parseCoexistence(config);
  if (!coexistence) return null;

  return (
    <>
      {coexistenceBadges(coexistence, now).map((badge) => (
        <Badge key={badge.label} tone={badge.tone}>
          {badge.label}
          <InfoTip label={badge.label}>{badge.explain}</InfoTip>
        </Badge>
      ))}
    </>
  );
}

/**
 * How long a "Copy again" keeps re-reading the page after the action answers.
 * The action only enqueues; the request id the progress card polls on is
 * written by the job, a claim and a Graph call later — seconds, at priority 10.
 * A minute covers that with room, and ends on its own if Meta refuses again.
 */
const SYNC_REQUEST_FOLLOW_MS = 60_000;

/**
 * "Copy the contacts / history (again)" on a connected row. Hidden fields and
 * a button only, so React's reset after a refusal has nothing to move and the
 * plain form action is the right shape.
 *
 * After a success it keeps refreshing for a while, because the one refresh on
 * success lands before the worker has claimed the job: that page shows no
 * request yet, so nothing on it polls, and "this page updates as it arrives"
 * was true only after a manual reload. Once the job records the request the
 * row stops offering this button, which unmounts it and ends the burst — the
 * progress card's own polling takes over from there.
 */
export function RequestSyncAgain({
  channelId,
  type,
  again,
}: {
  channelId: string;
  type: SyncType;
  /** A request Meta refused is being tried again; a copy never asked for is not "again". */
  again: boolean;
}) {
  const [state, formAction] = useActionState(requestCoexistenceSync, INITIAL);
  const [following, setFollowing] = useState(false);
  const follow = useCallback(() => setFollowing(true), []);
  useRefreshOnSuccess(state, follow);
  // Restarted by each success (its nonce), so a second press gets its own minute.
  useEffect(() => {
    if (!following) return;
    const stop = setTimeout(() => setFollowing(false), SYNC_REQUEST_FOLLOW_MS);
    return () => clearTimeout(stop);
  }, [following, state.nonce]);
  useRefreshEvery(following ? 3_000 : null);
  const what = type === 'contacts' ? 'contacts' : 'history';

  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="channelId" value={channelId} />
      <input type="hidden" name="syncType" value={type} />
      <SubmitButton
        idle={`Copy ${what}${again ? ' again' : ''}`}
        busy="Asking the phone…"
        variant="secondary"
      />
      {state.error ? <span className="max-w-xs text-xs text-red-600">{state.error}</span> : null}
      {state.notice ? (
        <span className="max-w-xs text-xs text-[var(--muted-foreground)]">{state.notice}</span>
      ) : null}
    </form>
  );
}

// --- The credential ---------------------------------------------------------

function expiryLabel(status: CredentialStatus): string {
  if (status.inspectedAt === null) return 'expiry unknown';
  if (status.expiresAt === null) return 'never expires';
  return `expires ${formatDateTime(status.expiresAt)}`;
}

/**
 * What each of `credentialBadges`' kinds means and what to do about it — with
 * the detail its short label leaves out: which key, which variable, which date.
 * Matched on `kind`, so a reworded label cannot lose its explanation.
 */
function explainCredentialBadge(badge: CredentialBadge, status: CredentialStatus): ReactNode {
  switch (badge.kind) {
    case 'key_misconfigured':
      return status.keyProblem ?? 'WHATSAPP_CREDENTIAL_KEY could not be read on this service.';
    case 'key_not_set':
      return `It is sealed under key ${status.keyId}, and WHATSAPP_CREDENTIAL_KEY is not set on this service, so it cannot be opened and nothing can send with it. Set WHATSAPP_CREDENTIAL_KEY in the environment group.`;
    case 'key_unknown':
      return `It was sealed under key ${status.keyId}, which this deployment does not hold. Set that key as WHATSAPP_CREDENTIAL_KEY_PREVIOUS and run the rotation job — or press Reconnect, which stores a fresh credential under the current key.`;
    case 'key_previous':
      return `It is sealed under key ${status.keyId}, the one WHATSAPP_CREDENTIAL_KEY_PREVIOUS holds. Run \`npm run job -- rotate_whatsapp_credentials\` to reseal it under the current key before WHATSAPP_CREDENTIAL_KEY_PREVIOUS is unset.`;
    case 'refused':
      return `${status.lastRefusal ?? 'Meta refused the stored credential.'} Press Reconnect to store a fresh one.`;
    // Nothing fills the expiry in later: `check_meta_permissions` prints it and
    // writes nothing back, and only storing a credential records an inspection.
    case 'expiry_unknown':
      return "Meta's token inspection did not answer when this credential was stored, so its expiry is unknown and no warning will appear before it lapses. `npm run job -- check_meta_permissions` prints the expiry without saving it. Reconnect stores a fresh token and records its expiry when Meta's inspection answers.";
    case 'never_expires':
      return 'Meta said so when the token was inspected.';
    case 'expired':
      return `It expired${status.expiresAt ? ` ${formatDateTime(status.expiresAt)}` : ''}. Sends and the template sync fail with it. Press Reconnect to store a fresh one.`;
    case 'expires_soon':
      return `Press Reconnect before ${status.expiresAt ? formatDateTime(status.expiresAt) : 'then'}; after it every send from this account fails.`;
  }
}

/** The business account row's account of its stored credential — everything but the credential. */
export function CredentialCard({ status, now }: { status: CredentialStatus; now: Date }) {
  const source = status.source === 'embedded_signup' ? 'Embedded Signup' : status.source;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-[var(--muted-foreground)]">
        Stored from {source} on {formatDateTime(status.storedAt)} ·{' '}
        {status.tokenType ?? 'token type unknown'} · {expiryLabel(status)} · key {status.keyId}
      </p>
      <div className="flex flex-wrap gap-1">
        {credentialBadges(status, now).map((badge) => (
          <Badge key={badge.kind} tone={badge.tone}>
            {badge.label}
            <InfoTip label={badge.label}>{explainCredentialBadge(badge, status)}</InfoTip>
          </Badge>
        ))}
      </div>
    </div>
  );
}

/**
 * "Forget credential": deletes the sealed token and records who did; the
 * account and its numbers stay. Nothing changes at Meta — the hint says where
 * that is done, because this button cannot and should not look as if it had.
 *
 * The hint and the confirmation carry the consequence, because nothing else
 * can: on success the row re-renders without a credential and this control
 * unmounts with any notice it held. And the consequence is the shared token,
 * not "the account's variable" — storing the credential cleared the variable
 * and the edit form refuses one while a credential is stored, so a row written
 * through the console has none to fall back to.
 */
export function ForgetCredential({
  accountId,
  disabled = false,
}: {
  accountId: string;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <DangerAction
        action={forgetStoredCredential}
        id={accountId}
        label="Forget credential"
        confirmLabel="Forget — send with the shared token?"
        disabled={disabled}
      />
      <InfoTip label="Forget credential">
        Deletes the stored token. Sends and the template sync then use META_PAGE_ACCESS_TOKEN:
        connecting through Meta cleared any token variable this account named, so there is none to
        fall back to. If the shared token cannot reach this business, press Reconnect, or name a
        WHATSAPP_TOKEN_ variable with Edit afterwards. Revoking the token on Meta&rsquo;s side is
        done in Business Settings → Integrations → Connected apps, or by offboarding the number on
        the phone.
      </InfoTip>
    </span>
  );
}
