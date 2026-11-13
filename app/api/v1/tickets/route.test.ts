import { describe, expect, it } from 'vitest';
import { ErrorBody } from '@/lib/api/schemas';
import { withTestEnv } from '@/lib/testing/env';
import { GET, POST } from './route';

/**
 * `GET /tickets` is the list from stage 5, on the path `POST /tickets` serves
 * from stage 4, and both are exported from this one file: a method the file
 * did not export would be answered `405` by Next, which an SDK reads as its own
 * bug. Stage 4's stand-in answered `404` with no body; the list answers with
 * this API's body whatever it refuses, so the API switched off — the token
 * unset, as here — is its `503 not_configured`, before any session or query.
 * What the list answers is `tickets.db.test.ts`'s.
 */

withTestEnv();

describe('GET /api/v1/tickets', () => {
  it('is served beside POST, and answers with this API’s body, never an empty 404', async () => {
    expect(typeof POST).toBe('function');
    const response = await GET(
      new Request('https://support.shipblu.com/api/v1/tickets', {
        headers: { 'ShipBlu-Client': 'sdk-ts/0.2.0 app/5.4.1 ios/18.1' },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = ErrorBody.parse(await response.json());
    expect(body.error.code).toBe('not_configured');
    expect(body.error.requestId).toBe(response.headers.get('shipblu-request-id'));
  });
});
