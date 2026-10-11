import net from 'node:net';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateState, instrumentClient } from '@/db/client';
import { refuseUnlessDisposable } from '@/lib/testing/db';

/**
 * The admission gate in `db/client.ts`, against the real postgres.js and a real
 * Postgres, through a proxy that reads the wire.
 *
 * What the gate exists to prevent is not visible in any result: Supavisor's
 * transaction pooler (v2.9) hands a backend back to its pool on the first read
 * that ends in ReadyForQuery with the transaction closed, so a client that had
 * already written more work onto that connection loses the replies to it
 * (§6.91). Postgres itself answers a pipeline correctly, so a test against it
 * alone passes with or without the gate. The proxy here counts the shape
 * instead — a ReadyForQuery reporting `I` that arrives after the client has
 * already sent more — which is the exact moment the pooler drops what follows.
 * The first test proves the count is not vacuous: the same load without the
 * gate produces that shape.
 *
 * Nothing is truncated or written to a table, but the file is refused on the
 * same terms as every other `*.db.test.ts`.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

type WireConnection = {
  id: number;
  /** One entry per Sync or simple Query sent and not yet answered by ReadyForQuery. */
  owed: { followed: boolean }[];
  /** Server bytes held back rather than forwarded: a reply the pooler lost. */
  held: Buffer[] | null;
  client: net.Socket;
  upstream: net.Socket;
};

/**
 * A pass-through TCP proxy that parses both directions of the protocol.
 *
 * `crossings` counts each ReadyForQuery(`I`) whose batch the client had
 * already written past. `hold(marker)` makes the proxy stop forwarding
 * replies on whichever connection next sends a statement containing the
 * marker, and `release()` forwards everything held — a reply that arrives
 * late rather than never.
 */
async function startWireProxy(upstreamUrl: string) {
  const upstream = new URL(upstreamUrl);
  const connections = new Map<number, WireConnection>();
  let nextId = 1;
  let crossings = 0;
  let holdMarker: string | null = null;
  const sent: string[] = [];

  const server = net.createServer((client) => {
    const backend = net.connect(Number(upstream.port || 5432), upstream.hostname);
    const connection: WireConnection = {
      id: nextId++,
      owed: [],
      held: null,
      client,
      upstream: backend,
    };
    connections.set(connection.id, connection);

    let startup = true;
    let fromClient = Buffer.alloc(0);
    let fromServer = Buffer.alloc(0);

    client.on('data', (chunk: Buffer) => {
      backend.write(chunk);
      fromClient = Buffer.concat([fromClient, chunk]);
      // The first message has no type byte: a StartupMessage, or a
      // CancelRequest on a connection of its own.
      if (startup) {
        if (fromClient.length < 4) return;
        const length = fromClient.readUInt32BE(0);
        if (fromClient.length < length) return;
        fromClient = fromClient.subarray(length);
        startup = false;
      }
      while (fromClient.length >= 5) {
        const length = fromClient.readUInt32BE(1);
        if (fromClient.length < length + 1) break;
        const type = String.fromCharCode(fromClient[0]!);
        const body = fromClient.subarray(5, length + 1).toString('utf8');
        fromClient = fromClient.subarray(length + 1);

        // Anything sent while an earlier batch is owed its ReadyForQuery.
        for (const batch of connection.owed) batch.followed = true;
        if (type === 'S' || type === 'Q') connection.owed.push({ followed: false });
        if (type === 'Q' || type === 'P') {
          sent.push(body);
          if (holdMarker && body.includes(holdMarker)) {
            holdMarker = null;
            connection.held = [];
          }
        }
      }
    });

    backend.on('data', (chunk: Buffer) => {
      fromServer = Buffer.concat([fromServer, chunk]);
      while (fromServer.length >= 5) {
        const length = fromServer.readUInt32BE(1);
        if (fromServer.length < length + 1) break;
        const type = String.fromCharCode(fromServer[0]!);
        const status = String.fromCharCode(fromServer[5] ?? 0);
        fromServer = fromServer.subarray(length + 1);
        // The ReadyForQuery that ends authentication answers no batch.
        if (type === 'Z' && connection.owed.length > 0) {
          const batch = connection.owed.shift()!;
          if (status === 'I' && batch.followed) crossings += 1;
        }
      }
      if (connection.held) connection.held.push(chunk);
      else client.write(chunk);
    });

    const close = () => {
      client.destroy();
      backend.destroy();
      connections.delete(connection.id);
    };
    client.on('error', close);
    backend.on('error', close);
    client.on('close', close);
    backend.on('close', close);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const proxied = new URL(upstreamUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(port);

  return {
    url: proxied.toString(),
    crossings: () => crossings,
    sentContaining: (text: string) => sent.filter((body) => body.includes(text)).length,
    hold: (marker: string) => {
      holdMarker = marker;
    },
    release: () => {
      for (const connection of connections.values()) {
        const held = connection.held;
        connection.held = null;
        for (const chunk of held ?? []) connection.client.write(chunk);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections.values()) {
          connection.client.destroy();
          connection.upstream.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

type Proxy = Awaited<ReturnType<typeof startWireProxy>>;
type Sql = ReturnType<typeof postgres>;

/** The pool `getSql()` opens, pointed at the proxy. */
function openPool(url: string): Sql {
  return postgres(url, { prepare: false, max: 10, idle_timeout: 20, connect_timeout: 10 });
}

/**
 * A Channels-page-shaped burst: parameterless reads, which postgres.js sends as
 * a simple query and which leave a connection open to more, mixed with
 * parameterised ones, which it describes first. Each read says which one it is,
 * so a reply delivered to the wrong query fails the comparison.
 */
async function burst(sql: Sql, size: number): Promise<void> {
  const reads = Array.from({ length: size }, async (_, index) => {
    if (index % 3 === 0) {
      const rows = await sql.unsafe(`select ${index} as n, pg_sleep(0.01)`);
      expect(rows[0]?.n).toBe(index);
    } else {
      const rows = await sql.unsafe('select $1::int as n', [index]);
      expect(rows[0]?.n).toBe(index);
    }
  });
  await Promise.all(reads);
}

let proxy: Proxy;

beforeAll(async () => {
  refuseUnlessDisposable(databaseUrl, databaseUrl);
  proxy = await startWireProxy(databaseUrl!);
});

afterAll(async () => {
  await proxy?.close();
});

describe('the admission gate', () => {
  it('is needed: an ungated pool writes past a closing ReadyForQuery under a burst', async () => {
    const sql = instrumentClient(openPool(proxy.url), 30_000);
    const before = proxy.crossings();
    try {
      for (let round = 0; round < 5; round += 1) await burst(sql, 60);
    } finally {
      await sql.end({ timeout: 1 });
    }

    // If this ever reads zero, the count below proves nothing: postgres.js has
    // stopped pipelining, or the proxy has stopped seeing it.
    expect(proxy.crossings() - before).toBeGreaterThan(0);
  });

  it('never lets postgres.js write past a closing ReadyForQuery, transactions included', async () => {
    const sql = instrumentClient(openPool(proxy.url), 30_000, { admit: 8 });
    const before = proxy.crossings();
    try {
      const transactions = Array.from({ length: 12 }, (_, index) =>
        sql.begin(async (tx) => {
          // Concurrent statements inside a transaction are pipelined on its own
          // connection, and that is safe: every ReadyForQuery until the COMMIT
          // reports the transaction open, so the pooler keeps the backend.
          const [one, two] = await Promise.all([
            tx.unsafe('select $1::int as n', [index]),
            tx.unsafe(`select ${index} as n`),
          ]);
          await tx.savepoint((inner) => inner.unsafe('select $1::int as n', [index]));
          return [one[0]?.n, two[0]?.n];
        }),
      );
      for (let round = 0; round < 5; round += 1) await burst(sql, 60);
      expect(await Promise.all(transactions)).toEqual(
        Array.from({ length: 12 }, (_, index) => [index, index]),
      );
      expect(gateState(sql)).toMatchObject({ waiting: 0, lost: 0 });
    } finally {
      await sql.end({ timeout: 1 });
    }

    expect(proxy.crossings() - before).toBe(0);
  });

  it('refuses a query still waiting at its deadline without sending it', async () => {
    const sql = instrumentClient(openPool(proxy.url), 300, { admit: 2 });
    let finish = () => {};
    const done = new Promise<void>((resolve) => (finish = resolve));
    try {
      // A transaction holds its place for its whole life, statement or not, so
      // two open ones fill a gate of two for as long as the test says.
      const holders = [sql.begin(() => done), sql.begin(() => done)];
      await expect.poll(() => gateState(sql)?.admitted).toBe(2);

      const waiting = sql.unsafe(`select 'never-sent' as n`);
      await expect(waiting).rejects.toMatchObject({ code: '57014' });
      expect(proxy.sentContaining('never-sent')).toBe(0);

      finish();
      await Promise.all(holders);
      await expect.poll(() => gateState(sql)).toMatchObject({ admitted: 0, waiting: 0 });
    } finally {
      finish();
      await sql.end({ timeout: 1 });
    }
  });

  it('gives up on a query whose reply does not come, keeps its place, and takes it back late', async () => {
    const sql = instrumentClient(openPool(proxy.url), 200, { admit: 3, lostAfterMs: 300 });
    try {
      proxy.hold('wedge-me');
      const wedged = sql.unsafe(`select 'wedge-me' as n`);

      await expect(wedged).rejects.toMatchObject({
        code: '57014',
        message: expect.stringContaining('no answer') as unknown,
      });
      expect(gateState(sql)).toMatchObject({ admitted: 1, lost: 1 });

      // The pool goes on answering on the connections it has left, and never
      // pipelines onto the one still waiting.
      const before = proxy.crossings();
      await burst(sql, 12);
      expect(proxy.crossings() - before).toBe(0);

      // The reply comes after all: the connection is free again, and so is
      // its place.
      proxy.release();
      await expect.poll(() => gateState(sql)).toMatchObject({ admitted: 0, lost: 0 });
      await burst(sql, 6);
    } finally {
      proxy.release();
      await sql.end({ timeout: 1 });
    }
  });

  it('rejects a transaction whose statement never answers, and holds its place until it does', async () => {
    const sql = instrumentClient(openPool(proxy.url), 200, { admit: 3, lostAfterMs: 300 });
    try {
      const transaction = sql.begin(async (tx) => {
        await tx.unsafe('select $1::int as n', [1]);
        proxy.hold('wedge-in-transaction');
        await tx.unsafe(`select 'wedge-in-transaction' as n`);
      });

      await expect(transaction).rejects.toMatchObject({ code: '57014' });
      expect(gateState(sql)).toMatchObject({ admitted: 1, lost: 1 });

      proxy.release();
      await expect.poll(() => gateState(sql)).toMatchObject({ admitted: 0, lost: 0 });
      await burst(sql, 6);
    } finally {
      proxy.release();
      await sql.end({ timeout: 1 });
    }
  });
});
