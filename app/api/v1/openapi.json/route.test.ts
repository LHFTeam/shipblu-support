import { describe, expect, it, vi } from 'vitest';
import { ErrorBody } from '@/lib/api/schemas';
import { GET } from './route';

/**
 * The contract's route: what every answer of this API carries, and the address
 * bucket in front of it. The document itself is `lib/api/openapi.test.ts`'s;
 * here the builder is a stand-in, so twelve hundred requests do not each
 * serialise the whole contract.
 */
vi.mock('@/lib/api/openapi', () => ({
  openApiDocument: () => ({ openapi: '3.1.0', info: { title: 'stand-in', version: 'x' } }),
}));

let next = 0;
/** A fresh documentation address per test, so the buckets they fill are their own. */
const address = () => `198.51.100.${++next}`;

function ask(from: string): Response {
  return GET(
    new Request('https://support.shipblu.com/api/v1/openapi.json', {
      headers: { 'x-forwarded-for': from },
    }),
  );
}

describe('GET /api/v1/openapi.json', () => {
  it('answers the document with the headers every answer carries', async () => {
    const response = ask(address());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('shipblu-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toEqual({
      openapi: '3.1.0',
      info: { title: 'stand-in', version: 'x' },
    });
  });

  it('gives each request its own id', () => {
    const from = address();
    expect(ask(from).headers.get('shipblu-request-id')).not.toBe(
      ask(from).headers.get('shipblu-request-id'),
    );
  });

  it('refuses an address past 1,200 a minute, in the one error shape, and no other', async () => {
    const from = address();
    for (let i = 0; i < 1_200; i += 1) expect(ask(from).status).toBe(200);

    const refused = ask(from);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(refused.headers.get('cache-control')).toBe('no-store');

    const body = ErrorBody.parse(await refused.json());
    expect(body.error.code).toBe('rate_limited');
    // The id in the body is the header's, so a bug report quoting either finds the line.
    expect(body.error.requestId).toBe(refused.headers.get('shipblu-request-id'));

    expect(ask(address()).status).toBe(200);
  });
});
