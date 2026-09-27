import { describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { invites } from '@/db/schema';
import { withCleanDatabase } from '@/lib/testing/db';
import { findOpenInvite } from './invites';
import { hashToken } from './tokens';

/**
 * The lookup behind the activation page and the action that accepts it. A
 * token is the only credential an invite has, so what it opens is pinned
 * against the real table: a used or expired invite must open nothing.
 */

withCleanDatabase();

const NOW = new Date('2026-09-27T12:00:00Z');

async function invite(token: string, values: Partial<typeof invites.$inferInsert> = {}) {
  await db.insert(invites).values({
    tokenHash: hashToken(token),
    email: `${token}@shipblu.test`,
    name: token,
    expiresAt: new Date('2026-10-04T12:00:00Z'),
    ...values,
  });
}

describe('findOpenInvite', () => {
  it('opens the invite its token names', async () => {
    await invite('open');
    await invite('other');

    expect(await findOpenInvite('open', NOW)).toMatchObject({ email: 'open@shipblu.test' });
  });

  it('opens nothing for a token no invite has', async () => {
    await invite('open');

    expect(await findOpenInvite('guess', NOW)).toBeNull();
  });

  it('opens nothing once the invite is accepted', async () => {
    await invite('used', { acceptedAt: new Date('2026-09-26T12:00:00Z') });

    expect(await findOpenInvite('used', NOW)).toBeNull();
  });

  it('opens nothing from the moment it expires', async () => {
    await invite('expired', { expiresAt: NOW });

    expect(await findOpenInvite('expired', NOW)).toBeNull();
  });
});
