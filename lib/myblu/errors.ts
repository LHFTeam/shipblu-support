import { NextResponse } from 'next/server';

/**
 * Error bodies the myBlu app can actually show a customer.
 *
 * Two constraints from the other side of the wire, both load-bearing.
 *
 * **The body must carry `message`.** `extractErrorMessage` in myBlu's
 * `src/api/errors.ts` walks `message` → `detail` → `details` → any nested
 * string, and falls back to `Error code: 500` — which is what a customer sees
 * if this system answers with anything else. `detail` is sent alongside as the
 * same string, because that is the key the platform's own Django endpoints use
 * and the app's own error handling has been read against both.
 *
 * **The status code decides whether the customer stays signed in.** myBlu calls
 * `logout()` on *any* authenticated 401, clearing the whole session — so a
 * support token going stale must never be a 401, or a customer who has not
 * opened support in a week is signed out of the app for it. Hence:
 *
 *   401  only from the handshake, and only because `api.shipblu.com` itself
 *        rejected the platform bearer. Signing out is then correct: the token
 *        really is dead.
 *   403  the support session is stale or unknown. The app re-handshakes and
 *        retries; nobody is signed out.
 *   503  the platform could not be reached. Emphatically not 401 — a platform
 *        outage that logged every myBlu user out of the app would be a far
 *        worse failure than the outage.
 *
 * `code` is what the app branches on; `message` is what it renders. Every
 * message is a bilingual pair with both halves written, which is the same rule
 * every other customer-facing string in this system follows — with `ar` the
 * default, because Arabic is this product's front door.
 */

export type ErrorCode =
  /** The platform rejected the bearer. Only the handshake may answer this. */
  | 'platform_token_invalid'
  /** The support session is unknown, expired, or was revoked. */
  | 'support_session_expired'
  /** The platform could not be reached at all. */
  | 'platform_unavailable'
  | 'invalid_request'
  | 'not_found'
  | 'rate_limited'
  | 'server_error';

const MESSAGES: Record<ErrorCode, { en: string; ar: string }> = {
  platform_token_invalid: {
    en: 'Your session has ended. Please sign in again.',
    ar: 'انتهت جلستك. برجاء تسجيل الدخول مرة أخرى.',
  },
  support_session_expired: {
    en: 'Reconnecting to support. Please try again.',
    ar: 'جارٍ إعادة الاتصال بالدعم. برجاء المحاولة مرة أخرى.',
  },
  platform_unavailable: {
    en: 'Support chat is briefly unavailable. Please try again in a moment.',
    ar: 'دردشة الدعم غير متاحة مؤقتًا. برجاء المحاولة بعد قليل.',
  },
  invalid_request: {
    en: 'Something went wrong with that request.',
    ar: 'حدث خطأ في هذا الطلب.',
  },
  not_found: {
    en: 'We could not find that conversation.',
    ar: 'لم نتمكن من العثور على هذه المحادثة.',
  },
  rate_limited: {
    en: 'Too many requests. Please wait a moment.',
    ar: 'طلبات كثيرة جدًا. برجاء الانتظار قليلاً.',
  },
  server_error: {
    en: 'Something went wrong at our end. Please try again.',
    ar: 'حدث خطأ لدينا. برجاء المحاولة مرة أخرى.',
  },
};

/** The HTTP status each code answers with — see the header for why. */
const STATUS: Record<ErrorCode, number> = {
  platform_token_invalid: 401,
  support_session_expired: 403,
  platform_unavailable: 503,
  invalid_request: 400,
  not_found: 404,
  rate_limited: 429,
  server_error: 500,
};

/**
 * Arabic unless the request asks for English.
 *
 * Arabic is the default for the same reason it is the help centre's: it is the
 * language of this product's market, and defaulting to English would put a
 * fallback in front of the majority of customers whenever a header went
 * missing. Only the leading tag is read — `ar-EG` and `ar` are the same answer.
 */
export function localeFrom(request: Request): 'ar' | 'en' {
  const header = request.headers.get('accept-language') ?? '';
  return /^\s*en\b/i.test(header) ? 'en' : 'ar';
}

export function apiError(
  request: Request,
  code: ErrorCode,
  extra?: Record<string, unknown>,
): NextResponse {
  const message = MESSAGES[code][localeFrom(request)];

  return NextResponse.json(
    // `detail` repeats `message` rather than adding to it: the app tries them in
    // order and shows the first, so two different sentences would mean the one
    // the customer reads depends on which key the parser reached first.
    { code, message, detail: message, ...(extra ?? {}) },
    { status: STATUS[code] },
  );
}

/** Exported for the test that asserts every code has both halves written. */
export const ERROR_MESSAGES = MESSAGES;
export const ERROR_STATUS = STATUS;
