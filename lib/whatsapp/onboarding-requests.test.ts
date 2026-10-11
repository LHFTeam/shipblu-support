import { describe, expect, it } from 'vitest';
import {
  clientBusinessRequest,
  numberPlatformRequest,
  phoneNumbersRequest,
  readWabaRequest,
  smbAppDataRequest,
  subscribeAppRequest,
  subscribedAppsRequest,
  tokenExchangeUrl,
} from './onboarding-requests';

/**
 * Each shape against the page it follows, because Graph's answer to a wrong
 * one is a refusal that names no cause — and for a field it does not know, a
 * refusal of the whole call. The fields asked for are exactly the documented
 * ones; adding one here means finding it in the v23 reference first.
 */

const WABA = '102290129340398';
const PHONE = '106540352242922';

describe('the onboarding requests', () => {
  it('exchanges the code the documented way: GET, three query parameters, no redirect_uri', () => {
    const url = tokenExchangeUrl('https://graph.facebook.com/v23.0', {
      appId: '236484624622562',
      appSecret: 'the-app-secret',
      code: 'AQBx-code',
    });
    expect(url.origin + url.pathname).toBe('https://graph.facebook.com/v23.0/oauth/access_token');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: '236484624622562',
      client_secret: 'the-app-secret',
      code: 'AQBx-code',
    });
  });

  it('reads the WABA for its default fields only — v23 has no owner_business_info', () => {
    expect(readWabaRequest(WABA)).toEqual({ method: 'GET', path: `${WABA}?fields=id,name` });
  });

  it('lists the numbers with the reference’s own fields and page size', () => {
    expect(phoneNumbersRequest(WABA)).toEqual({
      method: 'GET',
      path: `${WABA}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`,
    });
  });

  it('asks the number itself whether it is on the Business app, as the coexistence guide does', () => {
    expect(numberPlatformRequest(PHONE)).toEqual({
      method: 'GET',
      path: `${PHONE}?fields=is_on_biz_app,platform_type`,
    });
  });

  it('asks the token which business it was issued for', () => {
    expect(clientBusinessRequest()).toEqual({
      method: 'GET',
      path: 'me?fields=client_business_id',
    });
  });

  it('subscribes with an empty POST, and reads the subscription back', () => {
    expect(subscribeAppRequest(WABA)).toEqual({ method: 'POST', path: `${WABA}/subscribed_apps` });
    expect(subscribedAppsRequest(WABA)).toEqual({ method: 'GET', path: `${WABA}/subscribed_apps` });
  });

  it("asks for each copy with Meta's sync_type", () => {
    expect(smbAppDataRequest(PHONE, 'contacts')).toEqual({
      method: 'POST',
      path: `${PHONE}/smb_app_data`,
      body: { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' },
    });
    expect(smbAppDataRequest(PHONE, 'history').body).toEqual({
      messaging_product: 'whatsapp',
      sync_type: 'history',
    });
  });

  /** The ids arrive from a browser on the first phase, and become a path. */
  it('refuses an id that is not a Meta id before it reaches a path', () => {
    for (const bad of ['', '12', '1/../me', '123abc', `${WABA}?fields=access_token`]) {
      expect(() => readWabaRequest(bad)).toThrow(/numeric Meta id/);
      expect(() => smbAppDataRequest(bad, 'history')).toThrow(/numeric Meta id/);
    }
  });
});
