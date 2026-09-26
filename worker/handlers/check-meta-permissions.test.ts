import { describe, expect, it } from 'vitest';
import { stubFetch } from '@/lib/testing/fetch';
import { withTestEnv } from '@/lib/testing/env';
import { checkMetaPermissions } from './check-meta-permissions';

/**
 * This job's value is that what it prints is true. It read the body with
 * `.json().catch(() => null)`, which swallowed a deadline passing mid-body into
 * the same null as a body that was not JSON — and reported a token Graph had
 * answered 200 for as refused.
 */

function answer(status: number, body: BodyInit) {
  stubFetch(async () => new Response(body, { status }));
}

withTestEnv({ META_APP_ID: '123', META_APP_SECRET: 'secret', META_PAGE_ACCESS_TOKEN: 'token' });

describe('checkMetaPermissions', () => {
  it('says the deadline passed when debug_token stops answering mid-body', async () => {
    answer(
      200,
      new ReadableStream({
        start(controller) {
          controller.error(
            new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
          );
        },
      }),
    );

    await expect(checkMetaPermissions()).rejects.toThrow(/\/debug_token did not answer in 15s$/);
  });

  it('still reports a body that is not JSON as the answer it was', async () => {
    answer(502, '<html>Bad Gateway</html>');

    await expect(checkMetaPermissions()).rejects.toThrow('debug_token failed (HTTP 502): null');
  });
});
