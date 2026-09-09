import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;
type TransactionSql = postgres.TransactionSql;

export const WEB_STATEMENT_TIMEOUT_MS = 5_000;
export const WEB_DATABASE_DEADLINE_MS = 10_000;
export const WEB_POOL_COOLDOWN_MS = 5_000;

export class DatabaseDeadlineError extends Error {
  readonly code = 'WEB_DATABASE_DEADLINE';
  constructor() {
    super('Database operation exceeded its deadline; its outcome may be unknown.');
  }
}

type Generation = { raw: Sql; client: Sql; id: string; retired: boolean };
type Observation = { startedAt: number; poolId: string; kind: string };

/**
 * A web-only Drizzle adapter. Supavisor transaction pooling cannot promise a
 * session SET will follow the next query, so every operation uses a transaction
 * with SET LOCAL. Explicit Drizzle transactions share one deadline, including
 * BEGIN's pool wait, the callback, savepoints and COMMIT.
 *
 * We deliberately do not retry, cancel by backend PID (which can race with the
 * next pooled query), or recycle on 57014. Only a client deadline retires a pool:
 * a server timeout normally rejects within the shorter statement budget. Forced
 * end rejects outstanding work, including queued queries; the cooldown prevents
 * a failing dependency from causing an unbounded connection/retry loop.
 */
export class WebPool {
  private generation: Generation | undefined;
  private retryAfter = 0;
  private readonly outstanding = new Map<string, Observation>();

  constructor(
    private readonly create: () => Sql,
    private readonly policy = {
      statementMs: WEB_STATEMENT_TIMEOUT_MS,
      deadlineMs: WEB_DATABASE_DEADLINE_MS,
      cooldownMs: WEB_POOL_COOLDOWN_MS,
    },
    private readonly report: (event: Record<string, unknown>) => void = (event) =>
      console.warn('[web-db]', JSON.stringify(event)),
  ) {}

  getSql(): Sql {
    if (Date.now() < this.retryAfter) throw new Error('Database pool is recovering.');
    if (!this.generation) {
      const raw = this.create();
      const generation = { raw, client: raw, id: randomUUID(), retired: false };
      generation.client = this.adapt(generation);
      this.generation = generation;
      this.report({ event: 'pool_created', poolId: generation.id, max: raw.options.max });
    }
    return this.generation.client;
  }

  private assertLive(generation: Generation) {
    if (generation.retired) throw new DatabaseDeadlineError();
  }

  private observe<T>(generation: Generation, kind: string, run: () => Promise<T>): Promise<T> {
    this.assertLive(generation);
    const operationId = randomUUID();
    const startedAt = Date.now();
    this.outstanding.set(operationId, { startedAt, poolId: generation.id, kind });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const operations = [...this.outstanding.values()].filter(
          (op) => op.poolId === generation.id,
        );
        this.report({
          event: 'deadline',
          poolId: generation.id,
          operationId,
          kind,
          elapsedMs: Date.now() - startedAt,
          outstanding: operations.length,
          oldestMs: Date.now() - Math.min(...operations.map((op) => op.startedAt)),
        });
        // Invalidate before end(): callbacks released by shutdown must not issue
        // further queries, nor may a cached Drizzle instance reuse this client.
        if (!generation.retired) {
          generation.retired = true;
          if (this.generation === generation) this.generation = undefined;
          this.retryAfter = Date.now() + this.policy.cooldownMs;
          void generation.raw.end({ timeout: 0 }).catch(() => {
            this.report({ event: 'pool_close_failed', poolId: generation.id });
          });
        }
        this.outstanding.delete(operationId);
        reject(new DatabaseDeadlineError());
      }, this.policy.deadlineMs);
      // Attach both handlers immediately: late rejection after a deadline must
      // not become an unhandled rejection or overwrite the caller's result.
      Promise.resolve()
        .then(run)
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          this.outstanding.delete(operationId);
        });
    });
  }

  private adapt(generation: Generation, transaction?: TransactionSql): Sql {
    const target = transaction ?? generation.raw;
    return new Proxy(target, {
      get: (sql, property) => {
        if (property === 'unsafe') {
          return (...args: Parameters<Sql['unsafe']>) => {
            // postgres.js queries are lazy. Keep that property, including the
            // .values() shape Drizzle selects before awaiting the result.
            let values = false;
            let pending: Promise<unknown> | undefined;
            const execute = () => (pending ??= this.query(generation, transaction, args, values));
            const query = {
              then: (...handlers: Parameters<Promise<unknown>['then']>) =>
                execute().then(...handlers),
              catch: (...handlers: Parameters<Promise<unknown>['catch']>) =>
                execute().catch(...handlers),
              finally: (...handlers: Parameters<Promise<unknown>['finally']>) =>
                execute().finally(...handlers),
              values: () => {
                values = true;
                return query;
              },
            };
            return query;
          };
        }
        if (property === 'begin' || property === 'savepoint') {
          return (callback: (client: Sql) => Promise<unknown>) => {
            this.assertLive(generation);
            if (transaction) {
              return transaction.savepoint((tx) => callback(this.adapt(generation, tx)));
            }
            return this.observe(generation, 'transaction', () =>
              generation.raw.begin(async (tx) => {
                this.assertLive(generation);
                await tx.unsafe(`set local statement_timeout = '${this.policy.statementMs}ms'`);
                const result = await callback(this.adapt(generation, tx));
                this.assertLive(generation);
                return result;
              }),
            );
          };
        }
        const value: unknown = Reflect.get(sql, property);
        return typeof value === 'function' ? value.bind(sql) : value;
      },
      // The adapter is deliberately only for Drizzle's unsafe/begin/savepoint
      // protocol. Refuse raw tagged calls instead of silently bypassing budgets.
      apply: () => {
        throw new Error('Use db for web queries, not a raw SQL client.');
      },
    }) as Sql;
  }

  private query(
    generation: Generation,
    transaction: TransactionSql | undefined,
    args: Parameters<Sql['unsafe']>,
    values: boolean,
  ): Promise<unknown> {
    const execute = async (tx: TransactionSql) => {
      this.assertLive(generation);
      const query = tx.unsafe(...args);
      return values ? query.values() : query;
    };
    if (transaction) return execute(transaction);
    return this.observe(generation, 'query', () =>
      generation.raw.begin(async (tx) => {
        this.assertLive(generation);
        await tx.unsafe(`set local statement_timeout = '${this.policy.statementMs}ms'`);
        return execute(tx);
      }),
    );
  }

  async close(): Promise<void> {
    const generation = this.generation;
    this.generation = undefined;
    if (generation) {
      generation.retired = true;
      await generation.raw.end({ timeout: 0 });
    }
  }
}
