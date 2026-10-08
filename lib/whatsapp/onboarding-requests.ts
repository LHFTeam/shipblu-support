import type { GraphRequest } from './client';
import { META_SYNC_TYPE, type SyncType } from './coexistence';

/**
 * The Graph requests that connect a WhatsApp Business-app number, written down
 * in one place and asserted against Meta's reference in the test beside it.
 *
 * Written down rather than built inline because a wrong shape is invisible in
 * the response — Graph refuses a field it does not know by refusing the whole
 * call, with a sentence that reads like a permission problem — and because the
 * documentation for this flow is split across two generations of pages that do
 * not agree. Each request names the page it follows. Where they disagree, the
 * request asks for less: an extra field is the one mistake that fails the call.
 *
 * Pure: the ids are checked here, before they are put into a path, because a
 * path is built from them and they arrive from a browser on the first phase.
 */

/** Meta's ids for businesses, WABAs and phone numbers are numeric strings. */
const META_ID = /^\d{5,20}$/;

function id(value: string, what: string): string {
  if (!META_ID.test(value)) throw new Error(`${what} must be a numeric Meta id`);
  return value;
}

/**
 * Exchanges Embedded Signup's code for a business token: `GET /oauth/access_token`
 * with `client_id`, `client_secret` and `code` as query parameters.
 *
 * GET and a query string because that is the shape Meta documents ("Use the GET
 * /oauth/access_token endpoint to exchange the token code … for a business
 * integration system user access token", onboarding as a Tech Provider) and the
 * only one it documents. That puts the app secret and the code in a URL, so this
 * builds the URL and nothing else: the caller sends it with its own `fetch`,
 * outside every Graph client in this repo, and names the request by host and
 * path in anything it says — never the URL.
 */
export function tokenExchangeUrl(
  base: string,
  input: {
    appId: string;
    appSecret: string;
    code: string;
  },
): URL {
  const url = new URL(`${base}/oauth/access_token`);
  url.searchParams.set('client_id', id(input.appId, 'the app id'));
  url.searchParams.set('client_secret', input.appSecret);
  url.searchParams.set('code', input.code);
  return url;
}

/**
 * The WABA, read with the new token — the proof that the token reaches the
 * account the browser named.
 *
 * `id,name` and no more. v23's node lists `name`, and the newer reference lists
 * `id, name` as the default fields; neither lists `owner_business_info`, which
 * an older plan of this asked for.
 */
export function readWabaRequest(wabaId: string): GraphRequest {
  return { method: 'GET', path: `${id(wabaId, 'the WABA id')}?fields=id,name` };
}

/**
 * The business the token was issued for: `GET /me?fields=client_business_id`,
 * with the business token — Facebook Login for Business's own way of naming the
 * client's business. The session event from Meta's window names a
 * `business_id` too, but that arrives from a browser; this is Meta saying it.
 */
export function clientBusinessRequest(): GraphRequest {
  return { method: 'GET', path: 'me?fields=client_business_id' };
}

/**
 * The WABA's numbers: `GET /{WABA-ID}/phone_numbers`, with fields from the
 * reference's list ("id, display_phone_number, verified_name, status, …").
 * `platform_type` is not in that list, so it is asked for on the number itself
 * (`numberPlatformRequest`), where the coexistence guide asks for it.
 */
export function phoneNumbersRequest(wabaId: string): GraphRequest {
  return {
    method: 'GET',
    // `limit` is the reference's own parameter (max 100): the default page is
    // smaller, and a number past it would read as "not on this account".
    path: `${id(wabaId, 'the WABA id')}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`,
  };
}

/**
 * Whether the number is on the WhatsApp Business app as well as Cloud API — the
 * coexistence guide's "check onboarding status (optional)": `is_on_biz_app`
 * true and `platform_type` `CLOUD_API`.
 */
export function numberPlatformRequest(phoneNumberId: string): GraphRequest {
  return {
    method: 'GET',
    path: `${id(phoneNumberId, 'the phone number id')}?fields=is_on_biz_app,platform_type`,
  };
}

/**
 * Subscribes this app to the WABA's webhooks: `POST /{WABA-ID}/subscribed_apps`,
 * no body. A body-less subscribe also clears any WABA-level callback override;
 * this app sets none, and the WABA was just handed to it, so there is none to
 * clear.
 */
export function subscribeAppRequest(wabaId: string): GraphRequest {
  return { method: 'POST', path: `${id(wabaId, 'the WABA id')}/subscribed_apps` };
}

/**
 * The apps subscribed to the WABA, read back — a 200 on the subscribe is not
 * proof. Each entry is `{ whatsapp_business_api_data: { id, name, link } }`.
 */
export function subscribedAppsRequest(wabaId: string): GraphRequest {
  return { method: 'GET', path: `${id(wabaId, 'the WABA id')}/subscribed_apps` };
}

/**
 * Asks the phone to copy its contacts or its chat history: `POST
 * /{PHONE-NUMBER-ID}/smb_app_data` with `messaging_product: "whatsapp"` and the
 * `sync_type`. Meta answers `{ messaging_product, request_id }`, and the copy
 * itself arrives as webhooks.
 */
export function smbAppDataRequest(phoneNumberId: string, type: SyncType): GraphRequest {
  return {
    method: 'POST',
    path: `${id(phoneNumberId, 'the phone number id')}/smb_app_data`,
    body: { messaging_product: 'whatsapp', sync_type: META_SYNC_TYPE[type] },
  };
}

/** Whether `value` is a Meta id this module will put into a path. */
export function isMetaId(value: string): boolean {
  return META_ID.test(value);
}
