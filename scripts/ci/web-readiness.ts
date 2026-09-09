import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

async function main() {
  const database = new URL(process.env.DATABASE_URL!);
  assert(
    ['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname === '/shipblu_ci',
  );
  const port = 3197;
  let logs = '';
  const app = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-p', String(port)],
    {
      env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  app.stdout.on('data', (chunk: Buffer) => {
    logs += chunk.toString();
  });
  app.stderr.on('data', (chunk: Buffer) => {
    logs += chunk.toString();
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (app.exitCode !== null) throw new Error('Next exited during startup');
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
        const result = (await response.json()) as { status: string };
        if (response.status === 200 && result.status === 'ok') {
          ready = true;
          break;
        }
      } catch {
        /* Startup is not ready yet. */
      }
      await delay(500);
    }
    assert(ready, 'production readiness must complete a real Server Component + DB read');
    const publicProbe = await fetch(`${base}/api/health/render`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert(
      !(await publicProbe.text()).includes('data-readiness='),
      'public requests must not mint a successful probe',
    );
    const search = await fetch(`${base}/api/widget/search?q=readiness&locale=en`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(search.status, 200);
    assert(Array.isArray(((await search.json()) as { articles: unknown }).articles));
    await delay(100);
    // Health rendered through the page layer, search queried through a route
    // handler. Exactly one event proves their production module copies share it.
    assert.equal(
      (logs.match(/"event":"pool_created"/g) ?? []).length,
      1,
      'page and route handler must share one web pool',
    );
    console.log('production: full render readiness, private probe and one cross-layer pool passed');
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    if (app.exitCode === null && app.signalCode === null) {
      const exited = once(app, 'exit');
      app.kill('SIGTERM');
      const force = setTimeout(() => app.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
