import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import { isRenderProbeRequest, renderProbeToken, within } from './probe';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.APP_SECRET = 'x'.repeat(32);
  resetEnvCache();
});

afterEach(() => {
  resetEnvCache();
});

// `/probe` is public in proxy.ts, so this check is the only thing between a
// stranger and a database query per request.
describe('isRenderProbeRequest', () => {
  it('accepts the token the health check sends', () => {
    expect(isRenderProbeRequest(renderProbeToken())).toBe(true);
  });

  it('refuses a missing, wrong or truncated token', () => {
    expect(isRenderProbeRequest(null)).toBe(false);
    expect(isRenderProbeRequest('')).toBe(false);
    expect(isRenderProbeRequest('nope')).toBe(false);
    expect(isRenderProbeRequest(renderProbeToken().slice(0, -1))).toBe(false);
  });

  it('refuses the token of a deployment with a different secret', () => {
    const other = renderProbeToken();
    process.env.APP_SECRET = 'y'.repeat(32);
    resetEnvCache();

    expect(isRenderProbeRequest(other)).toBe(false);
  });
});

describe('within', () => {
  it('abandons what it stops waiting for', async () => {
    process.env.DB_QUERY_TIMEOUT_MS = '20';
    resetEnvCache();
    let abandoned = false;

    await expect(
      within('never', new Promise(() => {}), () => {
        abandoned = true;
      }),
    ).rejects.toThrow('never did not answer in 20ms');
    expect(abandoned).toBe(true);

    delete process.env.DB_QUERY_TIMEOUT_MS;
  });
});
