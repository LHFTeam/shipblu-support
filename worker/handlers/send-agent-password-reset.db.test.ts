import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { agents, passwordResets } from '@/db/schema';
import { hashToken } from '@/lib/auth/tokens';
import { resetEnvCache } from '@/lib/env';
import type { ClaimedJob } from '@/lib/queue';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * The job that mints and mails an agent's reset link, against Postgres: the
 * link in the email is the one whose hash is stored, it is built on this
 * site's own address, and nothing is minted for a request nobody should be
 * mailed about any more.
 */

type Sent = { to: string; subject: string; textBody: string; htmlBody: string };
const sent = vi.hoisted(() => [] as Sent[]);
const provider = vi.hoisted(() => ({ fails: false }));
vi.mock('@/lib/email/transactional', () => ({
  sendTransactionalEmail: async (email: Sent) => {
    if (provider.fails) throw new Error('provider down');
    sent.push(email);
  },
}));

const { sendAgentPasswordReset } = await import('./send-agent-password-reset');

withCleanDatabase();

const ENV = {
  APP_URL: 'https://console.shipblu.test/',
  EMAIL_FROM_ADDRESS: 'support@shipblu.test',
};
let saved: Record<string, string | undefined>;

beforeEach(() => {
  sent.length = 0;
  provider.fails = false;
  saved = { APP_URL: process.env.APP_URL, EMAIL_FROM_ADDRESS: process.env.EMAIL_FROM_ADDRESS };
  Object.assign(process.env, ENV);
  resetEnvCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetEnvCache();
  vi.restoreAllMocks();
});

async function agent(values: Partial<typeof agents.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name: 'Mona', email: 'mona@shipblu.test', passwordHash: 'old-hash', ...values })
    .returning({ id: agents.id });
  return row!.id;
}

function job(agentId: string, createdAt: Date = new Date()): ClaimedJob {
  return {
    id: 'job-1',
    type: 'send_agent_password_reset',
    payload: { agentId },
    createdAt,
  } as unknown as ClaimedJob;
}

describe('sendAgentPasswordReset', () => {
  it('mails the agent a link on this site whose hash is the row it stored', async () => {
    const id = await agent();

    await sendAgentPasswordReset(job(id));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('mona@shipblu.test');
    const match = /https:\/\/console\.shipblu\.test\/reset\/([\w-]+)/.exec(sent[0]!.textBody);
    expect(match).not.toBeNull();
    expect(sent[0]!.subject).not.toContain(match![1]!);

    const rows = await db.select().from(passwordResets);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokenHash: hashToken(match![1]!), agentId: id, usedAt: null });
  });

  it('mails nothing, and mints nothing, for a request half an hour old', async () => {
    const id = await agent();

    await sendAgentPasswordReset(job(id, new Date(Date.now() - 31 * 60 * 1000)));

    expect(sent).toEqual([]);
    expect(await db.$count(passwordResets)).toBe(0);
  });

  it('mails nothing to an agent deactivated since they asked', async () => {
    const id = await agent({ isActive: false });

    await sendAgentPasswordReset(job(id));

    expect(sent).toEqual([]);
    expect(await db.$count(passwordResets)).toBe(0);
  });

  it.each(['APP_URL', 'EMAIL_FROM_ADDRESS'])(
    'fails the attempt before minting while %s is unset',
    async (name) => {
      delete process.env[name];
      resetEnvCache();
      const id = await agent();

      await expect(sendAgentPasswordReset(job(id))).rejects.toThrow(name);
      expect(await db.$count(passwordResets)).toBe(0);
    },
  );

  it('fails the attempt when the provider refuses, so the queue tries again', async () => {
    provider.fails = true;
    const id = await agent();

    await expect(sendAgentPasswordReset(job(id))).rejects.toThrow('provider down');
  });

  it('withdraws the link of a send that failed, so retries cannot fill the five an agent may hold', async () => {
    provider.fails = true;
    const id = await agent();

    // The queue's five attempts of one request, made while the provider is down.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(sendAgentPasswordReset(job(id))).rejects.toThrow('provider down');
    }
    expect(await db.$count(passwordResets)).toBe(0);

    // The provider is back: the agent's next request is mailed.
    provider.fails = false;
    await sendAgentPasswordReset(job(id));
    expect(sent).toHaveLength(1);
    expect(await db.$count(passwordResets)).toBe(1);
  });
});
