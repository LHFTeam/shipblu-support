import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every save and delete here takes the row's `id` from a form field. Passed
 * straight to a query, a malformed one reached Postgres, which answers with
 * error 22P02 rather than with no rows — so the action threw, returned no state,
 * and the admin saw a blank failure where the form promises a sentence.
 *
 * The database is replaced by one that fails loudly if asked anything: these
 * cases must be answered before a query is built.
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
vi.mock('@/lib/auth/guard', () => ({ requirePermission: async () => ({ id: 'admin-1' }) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// The settings actions live beside the pages they serve now; this reads them
// as one set, so each case below names an action the way it always has.
const actions = {
  ...(await import('./groups/actions')),
  ...(await import('./locations/actions')),
  ...(await import('./statuses/actions')),
  ...(await import('./fields/actions')),
  ...(await import('./forms/actions')),
  ...(await import('./canned/actions')),
  ...(await import('./auto-responses/actions')),
  ...(await import('./hours/actions')),
  ...(await import('./sla/actions')),
  ...(await import('./skills/actions')),
  ...(await import('./automations/actions')),
  ...(await import('./recipients/actions')),
  ...(await import('./agents/actions')),
  ...(await import('./channels/actions')),
  ...(await import('./tracking/actions')),
  ...(await import('./categories/actions')),
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const INITIAL = { error: null };

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockClear();
});

describe('settings actions given an id no row can have', () => {
  it.each([
    ['deleteGroup', actions.deleteGroup],
    ['deleteLocation', actions.deleteLocation],
    ['deleteStatus', actions.deleteStatus],
    ['deleteField', actions.deleteField],
    ['deleteCannedResponse', actions.deleteCannedResponse],
    ['deleteAutoResponse', actions.deleteAutoResponse],
    ['deleteHoliday', actions.deleteHoliday],
    ['deleteAutomationRule', actions.deleteAutomationRule],
    ['deleteWhatsAppAccount', actions.deleteWhatsAppAccount],
  ])('%s refuses it with a sentence, without querying', async (_name, action) => {
    await expect(action(INITIAL, form({ id: 'not-a-uuid' }))).resolves.toEqual({
      error: 'Nothing to delete',
    });
    for (const fn of Object.values(db)) expect(fn).not.toHaveBeenCalled();
  });

  it('a save that names one is told the row is gone, not handed a crash', async () => {
    const state = await actions.saveGroup(INITIAL, form({ id: 'not-a-uuid', name: 'Hubs' }));

    expect(state.error).toMatch(/no longer exists/);
    for (const fn of Object.values(db)) expect(fn).not.toHaveBeenCalled();
  });
});

// A value the CHECKs in `db/sql/003` would refuse is refused here first, with a
// sentence: the database answers a violated constraint with a crash, not one.
// And a blank threshold is not 0, which would let every answer file a ticket.
describe('saveClassifierSettings', () => {
  const valid = { mode: 'shadow', minProbability: '0.6', routingWindowMinutes: '5' };

  it.each([
    [{ ...valid, mode: 'on' }, /off, shadow or apply/],
    [{ ...valid, minProbability: '' }, /between 0 and 1/],
    [{ ...valid, minProbability: '1.5' }, /between 0 and 1/],
    [{ ...valid, minProbability: '-0.1' }, /between 0 and 1/],
    [{ ...valid, minProbability: 'high' }, /between 0 and 1/],
    [{ ...valid, routingWindowMinutes: '0' }, /from 1 to 30/],
    [{ ...valid, routingWindowMinutes: '31' }, /from 1 to 30/],
    [{ ...valid, routingWindowMinutes: '2.5' }, /from 1 to 30/],
    [{ ...valid, routingWindowMinutes: '' }, /from 1 to 30/],
  ])('refuses %o without writing', async (fields, message) => {
    const state = await actions.saveClassifierSettings(INITIAL, form(fields));

    expect(state.error).toMatch(message);
    for (const fn of Object.values(db)) expect(fn).not.toHaveBeenCalled();
  });
});
