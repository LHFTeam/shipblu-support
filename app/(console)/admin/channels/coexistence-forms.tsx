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
import { InfoTip } from '@/components/tooltip';
import { Badge, Button, Card, ErrorText, Field, Select, SuccessText } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { GRAPH_VERSION } from '@/lib/meta/graph';
import { RefreshScheduler } from '@/lib/realtime/refresh-scheduler';
import {
  type Coexistence,
  coexistenceBadges,
  HISTORY_PHASES,
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
  embeddedSignupLoginOptions,
  FB_SDK_URL,
  FINISH_WAIT_MS,
  isFacebookOrigin,
  parseSignupMessage,
  POPUP_BLOCKED_MS,
  SDK_LOAD_TIMEOUT_MS,
  type SignupMessage,
  signupStepLabel,
} from '@/lib/whatsapp/embedded-signup';
import {
  describeOnboarding,
  type OnboardingView,
  pollIntervalMs,
} from '@/lib/whatsapp/onboarding-view';
import { DangerAction, useRefreshOnSuccess } from '../forms-shared';
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
 * Whether `FB.init` has run in this document. The SDK calls `fbAsyncInit`
 * once, when it loads; a card closed and reopened finds the SDK already there
 * and must not wait for a call that will not come.
 */
let sdkInitialised = false;

// --- The connect card's phases ----------------------------------------------

type Phase =
  | { name: 'loading_sdk' }
  | { name: 'sdk_blocked' }
  | { name: 'idle'; error: string | null }
  | { name: 'popup_open' }
  | { name: 'popup_blocked' }
  | { name: 'cancelled'; step: string | null }
  | { name: 'meta_error'; message: string | null; sessionId: string | null }
  | { name: 'awaiting_number' }
  | { name: 'no_number' }
  | { name: 'finishing' }
  | { name: 'unanswered' }
  | { name: 'done'; notice: string };

type CardEvent =
  | { type: 'sdk_ready' }
  | { type: 'sdk_blocked' }
  | { type: 'opened' }
  | { type: 'popup_blocked' }
  | { type: 'closed' }
  | { type: 'cancelled'; step: string | null }
  | { type: 'meta_error'; message: string | null; sessionId: string | null }
  | { type: 'awaiting_number' }
  | { type: 'no_number' }
  | { type: 'finishing' }
  | { type: 'refused'; error: string }
  | { type: 'unanswered' }
  | { type: 'done'; notice: string };

/** The phases in which Meta's window is open and may still say something. */
const WINDOW_OPEN = new Set<Phase['name']>(['popup_open', 'awaiting_number']);

/**
 * Each event applies only from the phases it can follow, so a late message —
 * a CANCEL posted after the window closed, a second `sdk_ready` — cannot move
 * the card backwards out of `finishing` or `done`.
 */
function reduce(phase: Phase, event: CardEvent): Phase {
  switch (event.type) {
    case 'sdk_ready':
      return phase.name === 'loading_sdk' ? { name: 'idle', error: null } : phase;
    case 'sdk_blocked':
      return phase.name === 'loading_sdk' ? { name: 'sdk_blocked' } : phase;
    case 'opened':
      return { name: 'popup_open' };
    case 'popup_blocked':
      return phase.name === 'popup_open' ? { name: 'popup_blocked' } : phase;
    case 'closed':
      return WINDOW_OPEN.has(phase.name) ? { name: 'cancelled', step: null } : phase;
    case 'cancelled':
      return WINDOW_OPEN.has(phase.name) ? { name: 'cancelled', step: event.step } : phase;
    case 'meta_error':
      return WINDOW_OPEN.has(phase.name)
        ? { name: 'meta_error', message: event.message, sessionId: event.sessionId }
        : phase;
    case 'awaiting_number':
      return phase.name === 'popup_open' ? { name: 'awaiting_number' } : phase;
    case 'no_number':
      return phase.name === 'awaiting_number' ? { name: 'no_number' } : phase;
    case 'finishing':
      return WINDOW_OPEN.has(phase.name) ? { name: 'finishing' } : phase;
    case 'refused':
      return phase.name === 'finishing' ? { name: 'idle', error: event.error } : phase;
    case 'unanswered':
      return phase.name === 'finishing' ? { name: 'unanswered' } : phase;
    case 'done':
      return phase.name === 'finishing' ? { name: 'done', notice: event.notice } : phase;
  }
}

/** The plan's copy for each phase. `idle` with no error says nothing. */
function phaseCopy(phase: Phase): { text: string; tone: 'muted' | 'error' | 'success' } | null {
  switch (phase.name) {
    case 'loading_sdk':
      return { text: "Loading Meta's sign-in…", tone: 'muted' };
    case 'sdk_blocked':
      return {
        text:
          "Meta's sign-in script could not be loaded — usually a content blocker. Allow " +
          'connect.facebook.net for this page and reload.',
        tone: 'error',
      };
    case 'idle':
      return phase.error ? { text: phase.error, tone: 'error' } : null;
    case 'popup_open':
      return {
        text: "Meta's window is open. Finish the steps there — this page updates when you do.",
        tone: 'muted',
      };
    case 'popup_blocked':
      return {
        text: 'Your browser blocked the window. Allow pop-ups for this site and press Continue again.',
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
const RETRYABLE = new Set<Phase['name']>([
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
 */
export function ConnectBusinessAppNumber({
  readiness,
  groups,
  suggestedGroupId,
  mode,
}: {
  readiness: ConnectReadiness;
  groups: Choice[];
  /** The one existing WhatsApp channel's group, when there is exactly one. */
  suggestedGroupId: string | null;
  mode: 'connect' | 'reconnect';
}) {
  const [open, setOpen] = useState(false);
  const label = mode === 'reconnect' ? 'Reconnect' : 'Connect a WhatsApp number';

  if (!open) {
    return mode === 'reconnect' ? (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
    ) : (
      <Button onClick={() => setOpen(true)}>{label}</Button>
    );
  }

  return (
    <Card data-expanded className="w-full border-brand-500/30">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{label}</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          Cancel
        </button>
      </div>
      {readiness.ready ? (
        <ConnectCard
          readiness={readiness}
          groups={groups}
          suggestedGroupId={suggestedGroupId}
          mode={mode}
        />
      ) : (
        <NotReady missing={readiness.missing} />
      )}
    </Card>
  );
}

/** The checklist, naming each variable and its group, with the button disabled. */
function NotReady({ missing }: { missing: { variable: string; why: string }[] }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-[var(--muted-foreground)]">
        This environment cannot open Meta&rsquo;s sign-in yet. Set these on Render — in the
        <code> shipblu-support-production</code> or <code>shipblu-support-staging</code> group,
        never both — and this page re-reads them on its next load:
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
}: {
  readiness: { ready: true; appId: string; configId: string };
  groups: Choice[];
  suggestedGroupId: string | null;
  mode: 'connect' | 'reconnect';
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [phase, dispatch] = useReducer(reduce, { name: 'loading_sdk' } as Phase);

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
  // reload can try again.
  useEffect(() => {
    let left = false;
    const ready = () => {
      if (!left) dispatch({ type: 'sdk_ready' });
    };

    if (window.FB && sdkInitialised) {
      ready();
      return;
    }

    const timer = setTimeout(() => dispatch({ type: 'sdk_blocked' }), SDK_LOAD_TIMEOUT_MS);
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: true, version: GRAPH_VERSION });
      sdkInitialised = true;
      clearTimeout(timer);
      ready();
    };

    if (!document.getElementById(SDK_SCRIPT_ID)) {
      const script = document.createElement('script');
      script.id = SDK_SCRIPT_ID;
      script.src = FB_SDK_URL;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.addEventListener('error', () => {
        script.remove();
        clearTimeout(timer);
        dispatch({ type: 'sdk_blocked' });
      });
      document.body.appendChild(script);
    }

    return () => {
      left = true;
      clearTimeout(timer);
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
          dispatch({
            type: 'refused',
            error: result.error ?? "Meta's window did not connect the number.",
          });
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
    dispatch({ type: 'opened' });

    fb.login((response) => {
      const code = response?.authResponse?.code;
      if (code) {
        codeRef.current = code;
        tryFinish();
        return;
      }
      // No code: the window was blocked, closed, or failed. Blocked is the
      // callback firing almost at once with nothing said; otherwise Meta's
      // CANCEL or ERROR usually lands around now, so it is given a moment to
      // name the step before the card calls it a plain close.
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
      if (Date.now() - clickedAt < POPUP_BLOCKED_MS) {
        dispatch({ type: 'popup_blocked' });
        return;
      }
      setTimeout(() => dispatch({ type: 'closed' }), 300);
    }, embeddedSignupLoginOptions(configId));
  }

  const copy = phaseCopy(phase);
  const busy =
    phase.name === 'popup_open' || phase.name === 'awaiting_number' || phase.name === 'finishing';
  const buttonLabel =
    phase.name === 'loading_sdk'
      ? "Loading Meta's sign-in…"
      : RETRYABLE.has(phase.name) || (phase.name === 'idle' && phase.error)
        ? 'Try again'
        : 'Continue with Meta';
  const canPress = phase.name === 'idle' || RETRYABLE.has(phase.name);

  return (
    <div className="flex flex-col gap-3 text-sm">
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
      {copy?.tone === 'success' ? <SuccessText>{copy.text}</SuccessText> : null}
      {copy?.tone === 'muted' ? (
        <p className="text-xs text-[var(--muted-foreground)]">{copy.text}</p>
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
 * backoff, the stall sentence, the retry, and the summary once it connected.
 */
export function OnboardingProgress({
  onboarding,
  coexistence,
  channelName,
  accountName,
  credential,
  canConnect,
  now,
}: {
  onboarding: OnboardingView;
  coexistence: Coexistence | null;
  channelName: string | null;
  accountName: string | null;
  credential: CredentialStatus | null;
  canConnect: boolean;
  /** The server's clock at render, so the page and this card agree on the sentences. */
  now: Date;
}) {
  // On the server's clock: every refresh renders a fresh `now`, so a copy
  // that stalls stops the polling on the next read without a clock of its own.
  useRefreshEvery(pollIntervalMs(onboarding, coexistence, now));

  const lines = describeOnboarding(onboarding, now);
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
        <>
          <ErrorText>{onboarding.error ?? 'The connection failed.'}</ErrorText>
          {canConnect ? <RetryOnboarding onboardingId={onboarding.id} /> : null}
        </>
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

/** The plan's "Done" block, from what the connection knows about itself. */
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

  const contacts = coexistence?.syncs.contacts;
  const contactsLine =
    contacts && 'requestId' in contacts && contacts.requestId
      ? `Contacts: ${contacts.received ?? 0} received.`
      : `Contacts: ${stepSentence('contacts')}`;

  const history = coexistence ? historyProgress(coexistence) : null;
  const phases = coexistence?.syncs.history?.progressByPhase ?? {};
  const historyLine = !history?.requested
    ? `History: ${stepSentence('history')}`
    : history.declined
      ? 'History: declined on the phone.'
      : `History: ${Array.from(
          { length: HISTORY_PHASES },
          (_, phase) => `phase ${phase} ${phases[String(phase)] ?? 0}%`,
        ).join(' · ')} (${history.chunks} chunk${history.chunks === 1 ? '' : 's'}).`;

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
      <p>
        Replies typed on the phone appear on tickets as &ldquo;WhatsApp Business app&rdquo;. Console
        replies go out over Cloud API. Nothing else to do.
      </p>
    </div>
  );
}

/** "Retry connection" — hidden field and a button, so a plain form action is right (§6.80). */
export function RetryOnboarding({ onboardingId }: { onboardingId: string }) {
  const [state, formAction] = useActionState(retryCoexistenceOnboarding, INITIAL);
  useRefreshOnSuccess(state);

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="onboardingId" value={onboardingId} />
      <SubmitButton idle="Retry connection" busy="Starting…" variant="secondary" />
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
 * "Copy the contacts / history (again)" on a connected row. Hidden fields and
 * a button only, so React's reset after a refusal has nothing to move and the
 * plain form action is the right shape.
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
  useRefreshOnSuccess(state);
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

/** What each of `credentialBadges`' labels means and what to do about it. */
function explainCredentialBadge(badge: CredentialBadge, status: CredentialStatus): ReactNode {
  const { label } = badge;
  if (label === 'credential key misconfigured') return status.keyProblem;
  if (label.startsWith('credential key not set')) {
    return 'The key this credential is sealed under is not set on this service, so it cannot be opened and nothing can send with it. Set WHATSAPP_CREDENTIAL_KEY in the environment group.';
  }
  if (label.startsWith('sealed under key')) {
    return `It was sealed under key ${status.keyId}, which this deployment does not hold. Set that key as WHATSAPP_CREDENTIAL_KEY_PREVIOUS and run the rotation job — or press Reconnect, which stores a fresh credential under the current key.`;
  }
  if (label.startsWith('sealed under the previous key')) {
    return 'Run `npm run job -- rotate_whatsapp_credentials` to reseal it under the current key before WHATSAPP_CREDENTIAL_KEY_PREVIOUS is unset.';
  }
  if (label === 'credential refused by Meta') {
    return `${status.lastRefusal ?? 'Meta refused the stored credential.'} Press Reconnect to store a fresh one.`;
  }
  if (label === 'expiry unknown') {
    return "Meta's token inspection did not answer when the credential was stored; the next check_meta_permissions run fills it in.";
  }
  if (label === 'never expires') return 'Meta said so when the token was inspected.';
  if (label === 'credential expired') {
    return 'Sends and the template sync fail with it. Press Reconnect to store a fresh one.';
  }
  if (label.startsWith('credential expires')) {
    return `Press Reconnect before ${status.expiresAt ? formatDateTime(status.expiresAt) : 'then'}; after it every send from this account fails.`;
  }
  return label;
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
          <Badge key={badge.label} tone={badge.tone}>
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
 */
export function ForgetCredential({ accountId }: { accountId: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <DangerAction
        action={forgetStoredCredential}
        id={accountId}
        label="Forget credential"
        confirmLabel="Really forget it?"
      />
      <InfoTip label="Forget credential">
        Deletes the stored token; sends and the template sync then use the account&rsquo;s token
        variable, or META_PAGE_ACCESS_TOKEN. Revoking it on Meta&rsquo;s side is done in Business
        Settings → Integrations → Connected apps, or by offboarding the number on the phone.
      </InfoTip>
    </span>
  );
}
