import { describe, expect, it } from 'vitest';
import { apiError, ERROR_MESSAGES, ERROR_STATUS, localeFrom, type ErrorCode } from './errors';

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://support.example/api/v1/support/conversations', { headers });
}

describe('the status a code answers with', () => {
  it('never answers 401 for a stale support session', async () => {
    // The single most consequential line in this integration. myBlu's HTTP
    // client calls logout() on *any* authenticated 401 and clears the whole
    // session — so a support token going stale as a 401 would sign a customer
    // out of the app for not having opened support in a week.
    expect(ERROR_STATUS.support_session_expired).toBe(403);
  });

  it('reserves 401 for the platform rejecting the bearer', () => {
    // The one case where signing out is correct: the token really is dead.
    expect(ERROR_STATUS.platform_token_invalid).toBe(401);
  });

  it('answers a platform outage with 503, not 401', () => {
    // An outage that logged every myBlu user out of the app would be a worse
    // failure than the outage.
    expect(ERROR_STATUS.platform_unavailable).toBe(503);
  });

  it('has exactly one code that can sign a customer out', () => {
    const signsOut = Object.entries(ERROR_STATUS).filter(([, status]) => status === 401);
    expect(signsOut).toEqual([['platform_token_invalid', 401]]);
  });
});

describe('the message a customer reads', () => {
  it('writes both halves of every pair', () => {
    // The repo's rule for anything a customer reads, and here it is load-bearing
    // twice over: an empty string would leave myBlu's extractErrorMessage
    // falling through to "Error code: 500", which is what a customer would then
    // see instead of a sentence.
    for (const [code, pair] of Object.entries(ERROR_MESSAGES)) {
      expect(pair.en.trim(), code).not.toBe('');
      expect(pair.ar.trim(), code).not.toBe('');
      // Arabic that is actually Arabic: a copy of the English string in the `ar`
      // slot passes a non-empty check and fails every reader.
      expect(pair.ar, code).toMatch(/[؀-ۿ]/);
    }
  });

  it('defaults to Arabic and switches only on an explicit English tag', () => {
    expect(localeFrom(request())).toBe('ar');
    expect(localeFrom(request({ 'accept-language': 'ar-EG,ar;q=0.9' }))).toBe('ar');
    expect(localeFrom(request({ 'accept-language': 'en-GB,en;q=0.9' }))).toBe('en');
    // Not a prefix match on any position: a header leading with Arabic is
    // Arabic, whatever else it lists afterwards.
    expect(localeFrom(request({ 'accept-language': 'ar,en;q=0.5' }))).toBe('ar');
  });

  it('puts the same sentence in message and detail', async () => {
    // myBlu tries message → detail → details and shows the first it finds, so
    // two different sentences would mean which one the customer reads depends
    // on which key the parser reached first.
    const response = apiError(request({ 'accept-language': 'en' }), 'not_found');
    const body = (await response.json()) as Record<string, string>;

    expect(response.status).toBe(404);
    expect(body.code).toBe('not_found');
    expect(body.message).toBe(body.detail);
    expect(body.message).toBe(ERROR_MESSAGES.not_found.en);
  });

  it('answers in Arabic when nothing asked for English', async () => {
    const body = (await apiError(request(), 'rate_limited').json()) as Record<string, string>;
    expect(body.message).toBe(ERROR_MESSAGES.rate_limited.ar);
  });

  it('covers every code the type declares', () => {
    // A code added to the union without a message would be a runtime undefined
    // reaching a customer as a blank error.
    const codes: ErrorCode[] = [
      'platform_token_invalid',
      'support_session_expired',
      'platform_unavailable',
      'invalid_request',
      'not_found',
      'rate_limited',
      'server_error',
    ];

    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...codes].sort());
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...codes].sort());
  });
});
