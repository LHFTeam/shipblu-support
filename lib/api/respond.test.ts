import { describe, expect, it } from 'vitest';
import type { ErrorCode } from './schemas';
import { apiError, apiJsonText } from './respond';

/**
 * How every `/api/v1` answer is built. The route's own test drives one through
 * a request; this holds the pieces a route cannot get wrong by itself — and,
 * for `Retry-After`, the ones it must not be able to get wrong at all, which
 * `npm run typecheck` checks rather than vitest.
 */

describe('apiError', () => {
  it('sends Retry-After on a 429, in whole seconds and at least one', () => {
    const answer = apiError('rate_limited', 'Too many.', {
      requestId: 'r',
      retryAfterSeconds: 0.2,
    });
    expect(answer.status).toBe(429);
    expect(answer.headers.get('retry-after')).toBe('1');
    expect(
      apiError('rate_limited', 'Too many.', { requestId: 'r', retryAfterSeconds: 6.1 }).headers.get(
        'retry-after',
      ),
    ).toBe('7');
  });

  it('sends none on any other code', () => {
    const answer = apiError('internal', 'Failed.', { requestId: 'r' });
    expect(answer.status).toBe(500);
    expect(answer.headers.has('retry-after')).toBe(false);
  });

  it('does not compile a 429 without Retry-After, nor Retry-After on another code', () => {
    // Never called: each line is here for the type checker to refuse.
    const unnarrowed = 'internal' as ErrorCode;
    const refused = () => [
      // @ts-expect-error `rate_limited` requires `retryAfterSeconds`.
      apiError('rate_limited', 'Too many.', { requestId: 'r' }),
      // @ts-expect-error `Retry-After` is published on a `429` alone.
      apiError('internal', 'Failed.', { requestId: 'r', retryAfterSeconds: 5 }),
      // @ts-expect-error a code not narrowed may be `rate_limited`.
      apiError(unnarrowed, 'Failed.', { requestId: 'r' }),
    ];
    expect(refused).toBeTypeOf('function');
  });
});

describe('apiJsonText', () => {
  it('sends a body already serialised as it is, with the headers every answer carries', async () => {
    const answer = apiJsonText('{"openapi":"3.1.0"}', { requestId: 'r' });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(answer.headers.get('shipblu-request-id')).toBe('r');
    expect(await answer.text()).toBe('{"openapi":"3.1.0"}');
  });
});
