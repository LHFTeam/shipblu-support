import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { kbImages } from '@/db/schema';
import { resetEnvCache } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';
import { stubFetch } from '@/lib/testing/fetch';
import { GET } from './route';

/**
 * The route every article's picture loads through, against real Postgres with
 * Storage's signing endpoint faked: what it answers, and that a page asking for
 * the same picture again costs no query and no signature.
 */

withCleanDatabase();

const SUPABASE = 'https://project.supabase.co';

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', SUPABASE);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role');
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

function signs() {
  return stubFetch((url) => {
    const path = url.slice(`${SUPABASE}/storage/v1/object/sign/attachments/`.length);
    return new Response(
      JSON.stringify({ signedURL: `/object/sign/attachments/${path}?token=t-${path}` }),
      { status: 200 },
    );
  });
}

const get = (id: string, ip = '203.0.113.7') =>
  GET(new Request(`http://localhost/api/kb/images/${id}`, { headers: { 'x-forwarded-for': ip } }), {
    params: Promise.resolve({ id }),
  });

async function picture(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(kbImages).values({
    id,
    storagePath: `kb/${id}.png`,
    contentType: 'image/png',
    sizeBytes: 16,
    sha256: 'a'.repeat(64),
    sourceUrl: `https://s3.amazonaws.com/cdn.freshdesk.com/${id}.png`,
  });
  return id;
}

describe('GET /api/kb/images/[id]', () => {
  it('redirects to a signed URL for the picture, cacheable by anybody for an hour', async () => {
    signs();
    const id = await picture();

    const response = await get(id);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      `${SUPABASE}/storage/v1/object/sign/attachments/kb/${id}.png?token=t-kb/${id}.png`,
    );
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('signs a picture once and hands every later reader the same URL', async () => {
    const signer = signs();
    const id = await picture();

    const first = await get(id);
    const second = await get(id, '198.51.100.1');

    expect(signer).toHaveBeenCalledTimes(1);
    expect(second.headers.get('location')).toBe(first.headers.get('location'));
  });

  it('answers 404 for an id it does not hold, and for one that is not an id', async () => {
    const signer = signs();

    expect((await get(crypto.randomUUID())).status).toBe(404);
    expect((await get('not-a-uuid')).status).toBe(404);
    expect((await get("1' or '1'='1")).status).toBe(404);
    expect(signer).not.toHaveBeenCalled();
  });

  it('reads an id written in capitals as the same picture', async () => {
    signs();
    const id = await picture();
    expect((await get(id.toUpperCase())).status).toBe(307);
  });
});
