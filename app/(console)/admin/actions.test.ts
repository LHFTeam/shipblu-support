import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The admin actions take an agent's, a channel's, a category's or a cause's id
 * from a form field. A malformed one reached Postgres, which answers with error
 * 22P02 rather than with no rows — the action threw, returned no state, and the
 * admin saw a blank failure. The database here fails loudly if asked anything,
 * so each case below has to be answered before a query is built.
 */

const untouchable = () => {
  throw new Error('the database was asked about an id that cannot exist');
};
const db = {
  select: vi.fn(untouchable),
  insert: vi.fn(untouchable),
  update: vi.fn(untouchable),
  delete: vi.fn(untouchable),
  transaction: vi.fn(untouchable),
};

vi.mock('@/db/client', () => ({ db }));
vi.mock('@/lib/auth/guard', () => ({
  requirePermission: async () => ({ id: 'admin-1', role: 'admin' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const actions = await import('./actions');

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const INITIAL = { error: null };
const MALFORMED = 'not-a-uuid';

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockClear();
});

function expectNoQuery() {
  for (const fn of Object.values(db)) expect(fn).not.toHaveBeenCalled();
}

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
});
