import { expect, vi } from 'vitest';

/**
 * A stand-in for `db` in a server action's unit test, for the questions an
 * action answers from a form before it — or instead of — reading a row.
 *
 * Install it with a factory that imports this module, rather than one closing
 * over a local constant: `vi.mock` is hoisted above the file's declarations, so
 * a factory naming a `const` in the test works only until something imported
 * statically reaches `@/db/client` first, and then fails as a TDZ error instead
 * of an assertion.
 *
 *     vi.mock('@/db/client', async () => ({
 *       db: (await import('@/lib/testing/fake-db')).fakeDb,
 *     }));
 */
export const fakeDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
  execute: vi.fn(),
};

/** Every query throws: the case under test must be answered before one is built. */
export function refuseEveryQuery(): void {
  for (const method of Object.values(fakeDb)) {
    method.mockReset();
    method.mockImplementation(() => {
      throw new Error('the database was asked about an id that cannot exist');
    });
  }
}

/**
 * Every query finds nothing: a well-formed id naming a row that is not there.
 *
 * Each builder call returns the same chain, and awaiting it gives no rows —
 * enough for `select…from…where…limit` and `update…set…where…returning`.
 */
export function answerNoRows(): void {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === 'then' ? (resolve: (rows: never[]) => void) => resolve([]) : () => chain,
    },
  );
  for (const method of Object.values(fakeDb)) {
    method.mockReset();
    method.mockImplementation(() => chain);
  }
}

export function expectNoQuery(): void {
  for (const method of Object.values(fakeDb)) expect(method).not.toHaveBeenCalled();
}

/** Nothing was inserted, updated or deleted, whatever was read first. */
export function expectNoWrite(): void {
  for (const method of [fakeDb.insert, fakeDb.update, fakeDb.delete]) {
    expect(method).not.toHaveBeenCalled();
  }
}

export function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
