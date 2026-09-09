import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  drizzle: vi.fn<(client: unknown, options: unknown) => unknown>(() => ({ execute: vi.fn() })),
}));
vi.mock('postgres', () => ({ default: mocks.create }));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: mocks.drizzle }));
vi.mock('@/lib/env', () => ({
  env: () => ({ DATABASE_URL: 'postgresql://localhost/test' }),
  sessionDatabaseUrl: () => 'postgresql://localhost/test',
}));

beforeEach(() => {
  vi.resetModules();
  mocks.create.mockReset();
  mocks.drizzle.mockClear();
  mocks.create.mockImplementation(() =>
    Object.assign(() => {}, {
      options: { max: 10 },
      end: vi.fn().mockResolvedValue(undefined),
    }),
  );
  vi.stubEnv('NODE_ENV', 'production');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  const { closeDb } = await import('./client');
  await closeDb();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('initialises lazily and shares one production web pool across module copies', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  const first = await import('./client');
  expect(mocks.create).not.toHaveBeenCalled();
  const client = first.getSql();
  vi.resetModules();
  const second = await import('./client');
  expect(second.getSql()).toBe(client);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(globalThis.__shipbluSql).toBeUndefined();
});

it('keeps production worker/cron processes on the raw client, without web deadlines', async () => {
  vi.stubEnv('NEXT_RUNTIME', undefined);
  const first = await import('./client');
  const client = first.getSql();
  expect(client).toBe(mocks.create.mock.results[0]!.value);
  expect(globalThis.__shipbluWebPool).toBeUndefined();
  vi.resetModules();
  expect((await import('./client')).getSql()).toBe(client);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

it('rebinds each module-local Drizzle instance when the shared pool generation changes', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  const first = await import('./client');
  void first.db.execute;
  vi.resetModules();
  const second = await import('./client');
  void second.db.execute;
  expect(mocks.drizzle).toHaveBeenCalledTimes(2);
  expect(mocks.drizzle.mock.calls[0]![0]).toBe(mocks.drizzle.mock.calls[1]![0]);
  await globalThis.__shipbluWebPool!.close();
  void first.db.execute;
  void second.db.execute;
  expect(mocks.create).toHaveBeenCalledTimes(2);
  expect(mocks.drizzle).toHaveBeenCalledTimes(4);
  expect(mocks.drizzle.mock.calls[2]![0]).toBe(mocks.drizzle.mock.calls[3]![0]);
  expect(mocks.drizzle.mock.calls[2]![0]).not.toBe(mocks.drizzle.mock.calls[0]![0]);
});
