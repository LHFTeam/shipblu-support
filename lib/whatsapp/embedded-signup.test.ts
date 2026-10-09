import { describe, expect, it, vi } from 'vitest';
import {
  type ConnectEvent,
  type ConnectPhase,
  connectWaitingOn,
  createSdkGate,
  EMBEDDED_SIGNUP_EXTRAS,
  embeddedSignupLoginOptions,
  isFacebookOrigin,
  parseSignupMessage,
  reduceConnectPhase,
  signupStepLabel,
  watchWindowOpen,
} from './embedded-signup';

/**
 * The browser half has no server to catch it: a wrong `FB.login` option opens
 * the wrong flow, an origin check with a hole lets any tab name a WABA, and a
 * parser that throws on one message stops hearing the next. Each is pinned.
 */

describe('embeddedSignupLoginOptions', () => {
  it('asks for a code, for the Business-app onboarding, in the documented shape', () => {
    expect(embeddedSignupLoginOptions('cfg-123')).toEqual({
      config_id: 'cfg-123',
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3',
      },
    });
    expect(embeddedSignupLoginOptions('cfg-123').extras).toBe(EMBEDDED_SIGNUP_EXTRAS);
  });
});

describe('isFacebookOrigin', () => {
  it('accepts Meta and its subdomains, and refuses look-alikes', () => {
    expect(isFacebookOrigin('https://www.facebook.com')).toBe(true);
    expect(isFacebookOrigin('https://facebook.com')).toBe(true);
    expect(isFacebookOrigin('https://business.facebook.com')).toBe(true);
    expect(isFacebookOrigin('https://evilfacebook.com')).toBe(false);
    expect(isFacebookOrigin('https://facebook.com.evil.test')).toBe(false);
    expect(isFacebookOrigin('https://notfacebook.com')).toBe(false);
    expect(isFacebookOrigin('null')).toBe(false);
    expect(isFacebookOrigin('')).toBe(false);
  });
});

describe('parseSignupMessage', () => {
  /** Meta's samples, as the window posts them: JSON strings. */
  it('reads the finish event, with and without the number', () => {
    expect(
      parseSignupMessage(
        JSON.stringify({
          data: { phone_number_id: '109876543210', waba_id: '102030405060' },
          type: 'WA_EMBEDDED_SIGNUP',
          event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
          version: '3',
        }),
      ),
    ).toEqual({
      kind: 'finished',
      wabaId: '102030405060',
      phoneNumberId: '109876543210',
      businessId: null,
    });

    // The coexistence guide's own sample carries only the WABA.
    expect(
      parseSignupMessage({
        data: { waba_id: '102030405060', business_id: '555666777' },
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'FINISH',
        version: '3',
      }),
    ).toEqual({
      kind: 'finished',
      wabaId: '102030405060',
      phoneNumberId: null,
      businessId: '555666777',
    });
  });

  it('reads a cancel with its step, and an error with its reference', () => {
    expect(
      parseSignupMessage(
        JSON.stringify({
          data: { current_step: 'PHONE_NUMBER_SETUP' },
          type: 'WA_EMBEDDED_SIGNUP',
          event: 'CANCEL',
          version: '3',
        }),
      ),
    ).toEqual({ kind: 'cancelled', step: 'PHONE_NUMBER_SETUP' });

    expect(
      parseSignupMessage(
        JSON.stringify({
          data: {
            error_message: 'Something went wrong',
            error_id: 'E123',
            session_id: 'sess-9',
          },
          type: 'WA_EMBEDDED_SIGNUP',
          event: 'ERROR',
          version: '3',
        }),
      ),
    ).toEqual({
      kind: 'error',
      message: 'Something went wrong',
      code: 'E123',
      sessionId: 'sess-9',
    });
  });

  it('answers null for everything else, and never throws', () => {
    for (const garbage of [
      'not json',
      '',
      null,
      undefined,
      42,
      [],
      {},
      { type: 'OTHER', event: 'FINISH' },
      { type: 'WA_EMBEDDED_SIGNUP', event: 'SOMETHING_NEW' },
      // A finish with no WABA names nothing to connect.
      { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: {} },
      { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: 'nonsense' },
      JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: 7 } }),
    ]) {
      expect(() => parseSignupMessage(garbage)).not.toThrow();
      expect(parseSignupMessage(garbage)).toBeNull();
    }
  });
});

describe('signupStepLabel', () => {
  it('words the documented step and prints an unknown one as Meta spelled it', () => {
    expect(signupStepLabel('PHONE_NUMBER_SETUP')).toBe('choosing the number');
    expect(signupStepLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});

describe('watchWindowOpen', () => {
  /** A stand-in for `window`, whose `open` answers what the browser would. */
  const host = (answer: Window | null) => {
    const open = vi.fn<Window['open']>(() => answer);
    return { target: { open }, open };
  };

  /**
   * The SDK never calls back for a window the browser refused, so this is the
   * only place the refusal shows: `window.open` answering null inside the call.
   */
  it('reads a refused window off window.open during the call', () => {
    const { target } = host(null);
    expect(watchWindowOpen(target, () => target.open('https://www.facebook.com/dialog'))).toBe(
      'blocked',
    );
  });

  it('reports a window that opened, and a call that opened nothing', () => {
    const opened = host({} as Window);
    expect(watchWindowOpen(opened.target, () => opened.target.open('https://x.test'))).toBe(
      'opened',
    );
    const untouched = host(null);
    expect(watchWindowOpen(untouched.target, () => undefined)).toBe('not_called');
  });

  it('puts the original back, even when the call throws', () => {
    const { target, open } = host(null);
    expect(() =>
      watchWindowOpen(target, () => {
        throw new Error('the SDK broke');
      }),
    ).toThrow('the SDK broke');
    expect(target.open).toBe(open);
  });

  /** The native `window.open` throws "Illegal invocation" when called on anything else. */
  it('calls the original with its own this, and passes its arguments through', () => {
    let receiver: unknown = null;
    const target = {
      open: function (this: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- the receiver is what is under test
        receiver = this;
        return null;
      } as Window['open'],
    };
    const spy = vi.spyOn(target, 'open');
    watchWindowOpen(target, () => target.open('https://x.test', '_blank', 'popup'));
    expect(receiver).toBe(target);
    expect(spy).toHaveBeenCalledWith('https://x.test', '_blank', 'popup');
  });
});

describe('createSdkGate', () => {
  /** What the SDK does once, when it loads: call `fbAsyncInit` unless it has run. */
  function sdkLoads(host: { fbAsyncInit?: () => void }) {
    const init = host.fbAsyncInit as ((() => void) & { hasRun?: boolean }) | undefined;
    if (init && init.hasRun !== true) {
      init.hasRun = true;
      init();
    }
  }

  const waiter = () => ({ ready: vi.fn(), blocked: vi.fn() });

  /**
   * Two cards open while the script downloads. With one `fbAsyncInit` per card
   * only the last assigned ran, and the first card's timeout reported a content
   * blocker while the SDK worked in the card beside it.
   */
  it('wakes every waiting card from the SDK’s one call, and initialises once', () => {
    const init = vi.fn();
    const host: { FB?: { init: typeof init }; fbAsyncInit?: () => void } = {};
    const gate = createSdkGate();
    const header = waiter();
    const row = waiter();
    gate.wait(host, 'app-1', header);
    gate.wait(host, 'app-1', row);

    host.FB = { init };
    sdkLoads(host);
    sdkLoads(host);

    expect(header.ready).toHaveBeenCalledOnce();
    expect(row.ready).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1' }));
    expect(gate.initialised).toBe(true);
  });

  it('forgets a card that closed, and answers a card opened later at once', () => {
    const host: { FB?: { init: () => void }; fbAsyncInit?: () => void } = {};
    const gate = createSdkGate();
    const closed = waiter();
    gate.wait(host, 'app-1', closed)();

    host.FB = { init: vi.fn() };
    sdkLoads(host);
    expect(closed.ready).not.toHaveBeenCalled();

    const later = waiter();
    gate.wait(host, 'app-1', later);
    expect(later.ready).toHaveBeenCalledOnce();
  });

  /** The tag comes down on an error and the next card injects it again. */
  it('tells waiting cards the script failed, and still wakes them if a later load works', () => {
    const host: { FB?: { init: () => void }; fbAsyncInit?: () => void } = {};
    const gate = createSdkGate();
    const card = waiter();
    gate.wait(host, 'app-1', card);

    gate.fail();
    expect(card.blocked).toHaveBeenCalledOnce();

    gate.wait(host, 'app-1', waiter());
    host.FB = { init: vi.fn() };
    sdkLoads(host);
    expect(card.ready).toHaveBeenCalledOnce();
  });
});

describe('reduceConnectPhase', () => {
  const run = (phase: ConnectPhase, ...events: ConnectEvent[]) =>
    events.reduce(reduceConnectPhase, phase);

  const finishing: ConnectPhase = { name: 'finishing' };
  const done: ConnectPhase = { name: 'done', notice: 'Connecting the number now.' };

  /** The ten-second timeout is a guess; a slow SDK that arrives after it is still a working SDK. */
  it('lets a late SDK lift "blocked", and never moves a card past it backwards', () => {
    const idle = { name: 'idle', error: null, wait: false };
    expect(run({ name: 'loading_sdk' }, { type: 'sdk_blocked', cause: 'timeout' })).toEqual({
      name: 'sdk_blocked',
      cause: 'timeout',
    });
    expect(
      run(
        { name: 'loading_sdk' },
        { type: 'sdk_blocked', cause: 'timeout' },
        { type: 'sdk_ready' },
      ),
    ).toEqual(idle);
    // The script failing outright is firmer than the timeout before it.
    expect(
      run(
        { name: 'loading_sdk' },
        { type: 'sdk_blocked', cause: 'timeout' },
        { type: 'sdk_blocked', cause: 'error' },
      ),
    ).toEqual({ name: 'sdk_blocked', cause: 'error' });
    expect(run(finishing, { type: 'sdk_ready' })).toBe(finishing);
    expect(run(done, { type: 'sdk_ready' })).toBe(done);
  });

  it('marks a window the SDK never opened, and moves a refused one to blocked', () => {
    expect(run({ name: 'idle', error: null, wait: false }, { type: 'opened' })).toEqual({
      name: 'popup_open',
      unseen: false,
    });
    expect(
      run(
        { name: 'idle', error: null, wait: false },
        { type: 'opened' },
        { type: 'popup_blocked' },
      ),
    ).toEqual({ name: 'popup_blocked' });
    expect(
      run(
        { name: 'idle', error: null, wait: false },
        { type: 'opened' },
        { type: 'window_unseen' },
      ),
    ).toEqual({ name: 'popup_open', unseen: true });
  });

  /**
   * Meta's window can post ERROR or CANCEL and stay open, and the business can
   * recover inside it and finish. The code and the FINISH that follow are this
   * press's, so the action's answer has to land.
   */
  it('accepts a finished sign-in after an ERROR or a CANCEL, and its answer after that', () => {
    const metaError: ConnectPhase = { name: 'meta_error', message: 'x', sessionId: null };
    const cancelled: ConnectPhase = { name: 'cancelled', step: 'PHONE_NUMBER_SETUP' };
    for (const from of [metaError, cancelled]) {
      expect(run(from, { type: 'finishing' })).toEqual(finishing);
      expect(run(from, { type: 'finishing' }, { type: 'done', notice: 'ok' })).toEqual({
        name: 'done',
        notice: 'ok',
      });
      expect(
        run(from, { type: 'finishing' }, { type: 'refused', error: 'no', wait: false }),
      ).toEqual({ name: 'idle', error: 'no', wait: false });
    }
  });

  it('holds "finishing" against late window messages, and refuses it where no window was', () => {
    expect(run(finishing, { type: 'meta_error', message: 'late', sessionId: null })).toBe(
      finishing,
    );
    expect(run(finishing, { type: 'cancelled', step: null })).toBe(finishing);
    expect(run(finishing, { type: 'closed' })).toBe(finishing);
    for (const from of [
      { name: 'idle', error: null, wait: false },
      done,
      { name: 'no_number' },
    ] satisfies ConnectPhase[]) {
      expect(run(from, { type: 'finishing' })).toBe(from);
    }
  });

  /** The rate limit and a live attempt: running Meta's window again would end the same way. */
  it('carries the "wait" mark of a refusal into the idle card', () => {
    expect(run(finishing, { type: 'refused', error: 'Too many attempts', wait: true })).toEqual({
      name: 'idle',
      error: 'Too many attempts',
      wait: true,
    });
  });
});

describe('connectWaitingOn', () => {
  const ALL: ConnectPhase[] = [
    { name: 'loading_sdk' },
    { name: 'sdk_blocked', cause: 'timeout' },
    { name: 'idle', error: null, wait: false },
    { name: 'popup_open', unseen: false },
    { name: 'popup_blocked' },
    { name: 'cancelled', step: null },
    { name: 'meta_error', message: null, sessionId: null },
    { name: 'awaiting_number' },
    { name: 'no_number' },
    { name: 'finishing' },
    { name: 'unanswered' },
    { name: 'done', notice: 'ok' },
  ];

  /** What the card's Cancel asks about: closing it then would lose Meta's answer. */
  it('waits on the window while it is open, on the action while it verifies, and else on nothing', () => {
    for (const answerDue of [true, false]) {
      expect(connectWaitingOn({ name: 'popup_open', unseen: false }, answerDue)).toBe('window');
      expect(connectWaitingOn({ name: 'awaiting_number' }, answerDue)).toBe('window');
      expect(connectWaitingOn({ name: 'finishing' }, answerDue)).toBe('verifying');
    }
    for (const phase of [
      { name: 'loading_sdk' },
      { name: 'sdk_blocked', cause: 'timeout' },
      { name: 'idle', error: null, wait: false },
      { name: 'popup_blocked' },
      { name: 'cancelled', step: null },
      { name: 'meta_error', message: null, sessionId: null },
      { name: 'no_number' },
      { name: 'unanswered' },
      { name: 'done', notice: 'ok' },
    ] satisfies ConnectPhase[]) {
      expect(connectWaitingOn(phase, false)).toBeNull();
    }
  });

  /**
   * An ERROR or a CANCEL leaves Meta's window open, and the business can still
   * finish in it; read as idle, a row let Edit or Disconnect unmount the card
   * whose listener that finish — and its thirty-second code — arrives on.
   */
  it('keeps waiting on the window after an ERROR or a CANCEL until the login callback fires', () => {
    expect(connectWaitingOn({ name: 'meta_error', message: 'x', sessionId: null }, true)).toBe(
      'window',
    );
    expect(connectWaitingOn({ name: 'cancelled', step: 'PHONE_NUMBER_SETUP' }, true)).toBe(
      'window',
    );
    expect(
      connectWaitingOn({ name: 'meta_error', message: 'x', sessionId: null }, false),
    ).toBeNull();
    expect(connectWaitingOn({ name: 'cancelled', step: null }, false)).toBeNull();
  });

  /** One rule for both: the card waits wherever a finish could still move it on. */
  it('waits in exactly the phases a finish can still move to finishing, while the answer is due', () => {
    for (const phase of ALL) {
      const finishable = reduceConnectPhase(phase, { type: 'finishing' }).name === 'finishing';
      const waiting = connectWaitingOn(phase, true);
      if (phase.name === 'finishing') expect(waiting).toBe('verifying');
      else expect(waiting === 'window').toBe(finishable);
    }
  });
});
