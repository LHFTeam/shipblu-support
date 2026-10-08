import { describe, expect, it } from 'vitest';
import {
  EMBEDDED_SIGNUP_EXTRAS,
  embeddedSignupLoginOptions,
  isFacebookOrigin,
  parseSignupMessage,
  signupStepLabel,
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
