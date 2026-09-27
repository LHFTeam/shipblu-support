import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedJob } from '@/lib/queue';

/**
 * A send job whose payload is missing what it sends fails once, before it
 * reads anything. Retrying it cannot supply the id, so it goes to `dead` on its
 * first attempt, with the field named in `last_error`.
 */

vi.mock('@/db/client', async () => ({ db: (await import('@/lib/testing/fake-db')).fakeDb }));

const { expectNoQuery, refuseEveryQuery } = await import('@/lib/testing/fake-db');
const { PermanentJobError } = await import('@/lib/queue');
const { sendEmail } = await import('./send-email');
const { sendSideEmail } = await import('./send-side-email');
const { sendWhatsApp } = await import('./send-whatsapp');
const { sendMeta } = await import('./send-meta');
const { sendAgentInvite } = await import('./send-agent-invite');
const { sendNotificationEmail } = await import('./send-notification-email');

beforeEach(() => {
  refuseEveryQuery();
});

describe.each([
  ['send_email', sendEmail],
  ['send_side_email', sendSideEmail],
  ['send_whatsapp', sendWhatsApp],
  ['send_meta', sendMeta],
  ['send_agent_invite', sendAgentInvite],
  ['send_notification_email', sendNotificationEmail],
] as const)('%s', (type, handler) => {
  it('fails an empty payload for good, before it reads a row', async () => {
    const job = { id: 'job-1', type, payload: {} } as unknown as ClaimedJob;

    await expect(handler(job)).rejects.toThrow(PermanentJobError);
    await expect(handler(job)).rejects.toThrow(`${type}: invalid payload`);
    expectNoQuery();
  });
});
