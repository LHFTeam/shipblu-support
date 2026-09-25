import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two faults the handler's own comment says no retry can fix — an invite
 * row with no retained token, and a token that no longer unseals — must fail
 * as `PermanentJobError`, so the queue marks the job dead on its first attempt
 * rather than retrying a row that cannot change.
 */

let row: Record<string, unknown> | undefined;

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
      }),
    }),
  },
}));

const sendTransactionalEmail = vi.fn(async () => {});
vi.mock('@/lib/email/transactional', () => ({ sendTransactionalEmail }));

const saved = { DATABASE_URL: process.env.DATABASE_URL, APP_SECRET: process.env.APP_SECRET };
process.env.DATABASE_URL = 'postgres://localhost/test';
process.env.APP_SECRET = 'test-secret-that-is-at-least-thirty-two-chars';

const { resetEnvCache } = await import('@/lib/env');
const { PermanentJobError } = await import('@/lib/queue');
const { sendAgentInvite } = await import('./send-agent-invite');

const INVITE_ID = '5b0c8f4e-7a1d-4c6b-9e2f-3a4b5c6d7e8f';

function job() {
  return {
    id: 'job-1',
    type: 'send_agent_invite',
    payload: { inviteId: INVITE_ID },
  } as unknown as Parameters<typeof sendAgentInvite>[0];
}

function invite(tokenCiphertext: string | null) {
  return {
    email: 'new.agent@example.com',
    name: 'New Agent',
    tokenCiphertext,
    expiresAt: new Date(Date.now() + 86_400_000),
    acceptedAt: null,
    invitedByName: 'Admin',
  };
}

beforeEach(() => {
  resetEnvCache();
  sendTransactionalEmail.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  process.env.DATABASE_URL = saved.DATABASE_URL;
  process.env.APP_SECRET = saved.APP_SECRET;
  resetEnvCache();
});

describe('sendAgentInvite', () => {
  it('fails a malformed payload for good', async () => {
    const bad = { ...job(), payload: { inviteId: 'not-a-uuid' } };
    await expect(sendAgentInvite(bad)).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('fails for good when the invite kept no token', async () => {
    row = invite(null);
    await expect(sendAgentInvite(job())).rejects.toBeInstanceOf(PermanentJobError);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('fails for good when the token no longer unseals', async () => {
    row = invite('v1.not.a.sealed-token');
    await expect(sendAgentInvite(job())).rejects.toBeInstanceOf(PermanentJobError);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it('returns quietly when the invite is gone, which is a race rather than a fault', async () => {
    row = undefined;
    await expect(sendAgentInvite(job())).resolves.toBeUndefined();
  });
});
