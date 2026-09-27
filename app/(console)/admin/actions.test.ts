import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  answerNoRows,
  expectNoQuery,
  expectNoWrite,
  formData as form,
  refuseEveryQuery,
} from '@/lib/testing/fake-db';

/**
 * The admin actions take an agent's, a channel's, a category's or a cause's id
 * from a form field. A malformed one reached Postgres, which answers with error
 * 22P02 rather than with no rows — the action threw, returned no state, and the
 * admin saw a blank failure. A well-formed one naming no row either broke a
 * foreign key the same way or updated nothing and reported success.
 */

const ADMIN_ID = '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44';

vi.mock('@/db/client', async () => ({ db: (await import('@/lib/testing/fake-db')).fakeDb }));
vi.mock('@/lib/auth/guard', () => ({
  requirePermission: async () => ({ id: '0b6f3c2e-8a51-4d3e-9f0a-2c7d1e5b9a44', role: 'admin' }),
}));
vi.mock('@/lib/auth/session', () => ({ destroyAllSessionsForAgent: async () => {} }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const actions = {
  ...(await import('./agents/actions')),
  ...(await import('./channels/actions')),
  ...(await import('./categories/actions')),
};

const INITIAL = { error: null };
const MALFORMED = 'not-a-uuid';
const NOBODY = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

beforeEach(() => {
  refuseEveryQuery();
});

describe('admin actions given an id no row can have', () => {
  it.each([
    ['setAgentActive', () => actions.setAgentActive(INITIAL, form({ agentId: MALFORMED }))],
    [
      'setAgentCapacity',
      () => actions.setAgentCapacity(INITIAL, form({ agentId: MALFORMED, maxOpenTickets: '5' })),
    ],
  ])('%s refuses the agent id with a sentence, without querying', async (_name, run) => {
    await expect(run()).resolves.toEqual({ error: 'Unknown agent' });
    expectNoQuery();
  });

  it.each([
    [
      'saveCategory',
      () => actions.saveCategory(INITIAL, form({ id: MALFORMED, labelEn: 'A', labelAr: 'ا' })),
      'Unknown category',
    ],
    [
      'setCategoryActive',
      () => actions.setCategoryActive(INITIAL, form({ id: MALFORMED, active: 'true' })),
      'Unknown category',
    ],
    [
      'saveRootCause',
      () => actions.saveRootCause(INITIAL, form({ id: MALFORMED, labelEn: 'A', labelAr: 'ا' })),
      'Unknown cause',
    ],
    [
      'setRootCauseActive',
      () => actions.setRootCauseActive(INITIAL, form({ id: MALFORMED, active: 'false' })),
      'Unknown cause',
    ],
  ])('%s refuses it with a sentence, without querying', async (_name, run, error) => {
    await expect(run()).resolves.toEqual({ error });
    expectNoQuery();
  });

  it('saveChannel refuses a malformed default group before writing the channel', async () => {
    const state = await actions.saveChannel(
      INITIAL,
      form({ name: 'Support inbox', type: 'email', defaultGroupId: MALFORMED }),
    );

    expect(state.error).toMatch(/group/i);
    expectNoQuery();
  });

  it('saveChannel refuses an edit whose own id is malformed', async () => {
    const state = await actions.saveChannel(INITIAL, form({ id: MALFORMED, name: 'Support' }));

    expect(state.error).toMatch(/out of date/);
    expectNoQuery();
  });
});

describe('admin actions given an id that means the same row in another spelling', () => {
  /**
   * Postgres matches an upper-case uuid to the lower-case row; `===` does not.
   * So the guard saying you cannot deactivate yourself compared the upper-case
   * spelling of your own id with your session's, found them different, and let
   * the update switch your own account off — recovering from which needs shell
   * access.
   */
  it('setAgentActive still refuses to deactivate yourself', async () => {
    const state = await actions.setAgentActive(
      INITIAL,
      form({ agentId: ADMIN_ID.toUpperCase(), active: 'false' }),
    );

    expect(state).toEqual({ error: 'You cannot deactivate your own account' });
    expectNoQuery();
  });
});

describe('admin actions given a well-formed id that names nothing', () => {
  beforeEach(() => {
    answerNoRows();
  });

  it.each([
    [
      'setAgentActive',
      () => actions.setAgentActive(INITIAL, form({ agentId: NOBODY, active: 'true' })),
      'Unknown agent',
    ],
    [
      'setAgentCapacity',
      () => actions.setAgentCapacity(INITIAL, form({ agentId: NOBODY, maxOpenTickets: '5' })),
      'Unknown agent',
    ],
    [
      'saveCategory',
      () => actions.saveCategory(INITIAL, form({ id: NOBODY, labelEn: 'A', labelAr: 'ا' })),
      'Unknown category',
    ],
    [
      'setCategoryActive',
      () => actions.setCategoryActive(INITIAL, form({ id: NOBODY, active: 'true' })),
      'Unknown category',
    ],
    [
      'saveRootCause',
      () => actions.saveRootCause(INITIAL, form({ id: NOBODY, labelEn: 'A', labelAr: 'ا' })),
      'Unknown cause',
    ],
    [
      'setRootCauseActive',
      () => actions.setRootCauseActive(INITIAL, form({ id: NOBODY, active: 'false' })),
      'Unknown cause',
    ],
  ])('%s says so rather than reporting a change that did not happen', async (_name, run, error) => {
    await expect(run()).resolves.toEqual({ error });
  });

  it('saveChannel refuses a default group that no longer exists, before writing', async () => {
    const state = await actions.saveChannel(
      INITIAL,
      form({ name: 'Support inbox', type: 'email', defaultGroupId: NOBODY }),
    );

    expect(state.error).toMatch(/group/i);
    expectNoWrite();
  });
});

describe('setAgentCapacity', () => {
  /** `max_open_tickets` is a 32-bit integer; Postgres answers anything larger with 22003. */
  it('refuses a cap the column cannot hold, without writing', async () => {
    const state = await actions.setAgentCapacity(
      INITIAL,
      form({ agentId: NOBODY, maxOpenTickets: '3000000000' }),
    );

    expect(state).toEqual({ error: 'That is not a number of tickets' });
    expectNoQuery();
  });
});
