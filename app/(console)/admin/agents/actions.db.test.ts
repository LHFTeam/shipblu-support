import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { agents, passwordResets, sessions } from '@/db/schema';
import { hashToken } from '@/lib/auth/tokens';
import { withCleanDatabase } from '@/lib/testing/db';

/**
 * Deactivating an agent, against Postgres, because it is one transaction: the
 * switch, their sessions and the reset links they hold end together. As three
 * statements, a failure after the first left an agent deactivated with a link
 * in their inbox that a later reactivation would have made work again.
 */

const ADMIN_ID = '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44';

vi.mock('@/lib/auth/guard', () => ({
  requirePermission: async () => ({ id: ADMIN_ID, role: 'admin', permissions: {} }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { setAgentActive } = await import('./actions');

withCleanDatabase();

const INITIAL = { error: null };
const HOUR = 60 * 60 * 1000;

async function agent(name: string): Promise<string> {
  const [row] = await db
    .insert(agents)
    .values({ name, email: `${name.toLowerCase()}@shipblu.test`, passwordHash: 'hash' })
    .returning({ id: agents.id });
  const expiresAt = new Date(Date.now() + HOUR);
  await db
    .insert(sessions)
    .values({ tokenHash: hashToken(`${name}-session`), agentId: row!.id, expiresAt });
  await db
    .insert(passwordResets)
    .values({ tokenHash: hashToken(`${name}-link`), agentId: row!.id, expiresAt });
  return row!.id;
}

function set(agentId: string, active: boolean) {
  const data = new FormData();
  data.set('agentId', agentId);
  data.set('active', String(active));
  return setAgentActive(INITIAL, data);
}

describe('setAgentActive', () => {
  it('ends the sessions and the reset links of the agent it deactivates, and nobody else’s', async () => {
    const mona = await agent('Mona');
    const omar = await agent('Omar');

    expect(await set(mona, false)).toEqual({ error: null });

    const [after] = await db
      .select({ isActive: agents.isActive })
      .from(agents)
      .where(eq(agents.id, mona));
    expect(after).toEqual({ isActive: false });
    expect(await db.select({ agentId: sessions.agentId }).from(sessions)).toEqual([
      { agentId: omar },
    ]);
    expect(await db.select({ agentId: passwordResets.agentId }).from(passwordResets)).toEqual([
      { agentId: omar },
    ]);
  });

  it('brings back no link when the agent is reactivated', async () => {
    const mona = await agent('Mona');
    await set(mona, false);

    expect(await set(mona, true)).toEqual({ error: null });

    expect(await db.$count(passwordResets)).toBe(0);
  });

  it('says so for an agent that does not exist, rather than reporting a change', async () => {
    expect(await set('5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', true)).toEqual({
      error: 'Unknown agent',
    });
  });
});
