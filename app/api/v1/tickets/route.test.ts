import { describe, expect, it } from 'vitest';
import { GET } from './route';

/**
 * `GET /tickets` is stage 5's, on the path `POST /tickets` serves from stage 4
 * (`plans/myblu-ticket-api.md`). Until then it answers as every operation not
 * served yet answers — `404` with no body of this API's — and never `405`,
 * which an SDK reads as its own bug rather than as a route still to come.
 */
describe('GET /api/v1/tickets, before its stage', () => {
  it('answers 404 with no body', async () => {
    const response = GET();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect(response.headers.get('content-type')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
