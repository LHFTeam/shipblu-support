import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedJob } from '@/lib/queue';

/**
 * The second family of checked payloads: the jobs ingest, the console and the
 * sweeps enqueue behind a customer's message. As with the sends, a payload
 * missing what the job acts on fails once, before it reads a row.
 */

vi.mock('@/db/client', async () => ({ db: (await import('@/lib/testing/fake-db')).fakeDb }));

const { expectNoQuery, refuseEveryQuery } = await import('@/lib/testing/fake-db');
const { PermanentJobError } = await import('@/lib/queue');
const { processWebhook } = await import('./process-webhook');
const { downloadMediaJob } = await import('./download-media');
const { moderateMetaComment } = await import('./moderate-meta-comment');
const { fetchMetaProfile } = await import('./fetch-meta-profile');
const { syncShipmentJob } = await import('./sync-shipment');
const { sendCsat } = await import('./send-csat');

beforeEach(() => {
  refuseEveryQuery();
});

describe.each([
  ['process_webhook', processWebhook],
  ['download_media', downloadMediaJob],
  ['moderate_meta_comment', moderateMetaComment],
  ['fetch_meta_profile', fetchMetaProfile],
  ['sync_shipment', syncShipmentJob],
  ['send_csat', sendCsat],
] as const)('%s', (type, handler) => {
  it('fails an empty payload for good, before it reads a row', async () => {
    const job = { id: 'job-1', type, payload: {} } as unknown as ClaimedJob;

    await expect(handler(job)).rejects.toThrow(PermanentJobError);
    await expect(handler(job)).rejects.toThrow(`${type}: invalid payload`);
    expectNoQuery();
  });
});
