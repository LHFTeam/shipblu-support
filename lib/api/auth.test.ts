import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { ErrorBody } from './schemas';

/**
 * The two planes' gates, short of the session table: the switch, the minting
 * token's rules, `ShipBlu-Client` and the `426` decided on it, and the order
 * each refusal comes in. The session lookup is stood in for, so a test can say
 * a refusal came before it; reading one is `app/api/v1/sessions.db.test.ts`'s.
 */

const lookup = vi.hoisted(() => ({
  calls: 0,
  live: `sbu_${'g'.repeat(43)}`,
  blocked: `sbu_${'b'.repeat(43)}`,
}));
vi.mock('./sessions', () => ({
  lookupSession: (token: string) => {
    lookup.calls += 1;
    if (token === lookup.live) {
      return Promise.resolve({
        kind: 'live',
        caller: {
          identityId: 'i',
          contactId: 'c',
          externalUserId: 'u',
          tokenHash: 'h',
          platform: 'ios',
          appVersion: '5.4.1',
        },
      });
    }
    if (token === lookup.blocked) {
      return Promise.resolve({ kind: 'blocked', identityId: 'ib', tokenHash: 'hb' });
    }
    return Promise.resolve({ kind: 'unauthenticated' });
  },
}));
const { belowMinimum, clientPlane, endingPlane, MINIMUM_VERSIONS, serverPlane, serverPlaneTokens } =
  await import('./auth');

const TOKEN = 'server-plane-token-0123456789-abcdefghij';
const PREVIOUS = 'previous-plane-token-0123456789-abcdefgh';

withTestEnv({ MYBLU_API_TOKEN: TOKEN });

beforeEach(() => {
  lookup.calls = 0;
});

let next = 0;
/** A fresh documentation address per request, so no bucket is shared by accident. */
function request(headers: Record<string, string> = {}, from = `203.0.113.${++next % 250}`) {
  return new Request('https://support.shipblu.com/api/v1/config', {
    headers: { 'x-forwarded-for': `${from}-${next}`, ...headers },
  });
}

const CLIENT = { 'ShipBlu-Client': 'sdk-ts/0.1.0 app/5.4.1 ios/18.1' };

async function codeOf(response: Response | null | undefined) {
  if (!response) return null;
  return { status: response.status, ...ErrorBody.parse(await response.json()).error };
}

describe('serverPlaneTokens', () => {
  it('is the current value, and the previous one beside it during a rotation', () => {
    expect(serverPlaneTokens()).toEqual([TOKEN]);
    setTestEnv({ MYBLU_API_TOKEN_PREVIOUS: PREVIOUS });
    expect(serverPlaneTokens()).toEqual([TOKEN, PREVIOUS]);
  });

  it('counts a value under 32 characters as unset, the current one or the previous', () => {
    setTestEnv({ MYBLU_API_TOKEN: 'x'.repeat(31) });
    expect(serverPlaneTokens()).toEqual([]);
    setTestEnv({ MYBLU_API_TOKEN: 'x'.repeat(32), MYBLU_API_TOKEN_PREVIOUS: 'short' });
    expect(serverPlaneTokens()).toEqual(['x'.repeat(32)]);
  });

  // The current value is the switch; the previous one only rides beside it.
  it('is empty while the current value is unset, whatever the previous one holds', () => {
    setTestEnv({ MYBLU_API_TOKEN: undefined, MYBLU_API_TOKEN_PREVIOUS: PREVIOUS });
    expect(serverPlaneTokens()).toEqual([]);
  });
});

describe('serverPlane', () => {
  it('lets the current value and the previous one through, and nothing else', async () => {
    setTestEnv({ MYBLU_API_TOKEN_PREVIOUS: PREVIOUS });
    expect(serverPlane(request({ Authorization: `Bearer ${TOKEN}` }), 'r', 'mint')).toBeNull();
    expect(serverPlane(request({ Authorization: `Bearer ${PREVIOUS}` }), 'r', 'mint')).toBeNull();

    for (const authorization of [
      undefined,
      `Bearer ${TOKEN}x`,
      `Basic ${TOKEN}`,
      // The value alone, as a careless backend might send it.
      TOKEN,
    ]) {
      const refused = serverPlane(
        request(authorization ? { Authorization: authorization } : {}),
        'r',
        'mint',
      );
      expect(await codeOf(refused)).toMatchObject({ status: 401, code: 'unauthenticated' });
    }
  });

  // The developer whose backend sent a header looks for why it was refused,
  // not for why it was never sent; neither sentence repeats the header.
  it('says whether the bearer was missing, malformed or wrong, and never repeats it', async () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'An Authorization bearer is required.'],
      ['', 'An Authorization bearer is required.'],
      [`Basic ${TOKEN}`, 'Authorization must be `Bearer <token>`.'],
      [TOKEN, 'Authorization must be `Bearer <token>`.'],
      ['Bearer not a token', 'Authorization must be `Bearer <token>`.'],
      [`Bearer ${TOKEN}x`, 'The bearer is not MYBLU_API_TOKEN as this server holds it.'],
    ];
    for (const [authorization, message] of cases) {
      const refused = await codeOf(
        serverPlane(
          request(authorization === undefined ? {} : { Authorization: authorization }),
          'r',
          'mint',
        ),
      );
      expect(refused, String(authorization)).toMatchObject({
        status: 401,
        code: 'unauthenticated',
        message,
      });
      expect(refused?.message).not.toContain(TOKEN);
    }
  });

  it('answers 503 not_configured while the token is unset or short, whatever is presented', async () => {
    setTestEnv({ MYBLU_API_TOKEN: undefined });
    expect(
      await codeOf(serverPlane(request({ Authorization: `Bearer ${TOKEN}` }), 'r', 'mint')),
    ).toMatchObject({ status: 503, code: 'not_configured' });

    setTestEnv({ MYBLU_API_TOKEN: TOKEN.slice(0, 31) });
    expect(
      await codeOf(
        serverPlane(request({ Authorization: `Bearer ${TOKEN.slice(0, 31)}` }), 'r', 'mint'),
      ),
    ).toMatchObject({ status: 503, code: 'not_configured' });
  });

  it('answers 429 past 120 bad bearers a minute from one address, and still lets the token through', async () => {
    const from = '198.51.100.77';
    const asking = (bearer: string) =>
      serverPlane(
        new Request('https://x/api/v1/sessions', {
          headers: { 'x-forwarded-for': from, Authorization: `Bearer ${bearer}` },
        }),
        'r',
        'mint',
      );
    for (let i = 0; i < 120; i += 1) expect((await codeOf(asking('wrong')))?.status).toBe(401);

    const refused = asking('wrong');
    expect(await codeOf(refused)).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(Number(refused?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Whoever spent the address's budget — anybody can write X-Forwarded-For —
    // cannot stop myBlu's backend minting.
    expect(asking(TOKEN)).toBeNull();
  });

  it('refuses the 601st call on the plane in a minute, whoever makes it', async () => {
    // The plane's bucket is one for the whole process, which the tests above
    // spent from: start this one in a minute of its own.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120_000);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    for (let i = 0; i < 600; i += 1) {
      expect(serverPlane(request({ Authorization: `Bearer ${TOKEN}` }), 'r', 'mint')).toBeNull();
    }
    expect(
      await codeOf(serverPlane(request({ Authorization: `Bearer ${TOKEN}` }), 'r', 'mint')),
    ).toMatchObject({ status: 429, code: 'rate_limited' });
  });

  // A cleanup job revoking a batch of deleted accounts spends the revoke
  // budget, and every app's next session is still minted.
  it('counts revokes apart from mints, so a batch of revokes stops no sign-in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 240_000);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const asking = (budget: 'mint' | 'revoke') =>
      serverPlane(request({ Authorization: `Bearer ${TOKEN}` }), 'r', budget);
    for (let i = 0; i < 600; i += 1) expect(asking('revoke')).toBeNull();
    expect(await codeOf(asking('revoke'))).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(asking('mint')).toBeNull();
  });
});

describe('clientPlane', () => {
  it('answers 503 before it reads a session while the API is switched off', async () => {
    setTestEnv({ MYBLU_API_TOKEN: undefined });
    const gate = await clientPlane(
      request({ ...CLIENT, Authorization: `Bearer sbu_${'a'.repeat(43)}` }),
      { requestId: 'r', route: 'GET /config', now: new Date() },
    );
    expect('refusal' in gate && (await codeOf(gate.refusal))).toMatchObject({
      status: 503,
      code: 'not_configured',
    });
    expect(lookup.calls).toBe(0);
  });

  it('requires ShipBlu-Client, and refuses one that does not parse, before the session', async () => {
    const variants: Record<string, string>[] = [
      {},
      { 'ShipBlu-Client': 'my app' },
      { 'ShipBlu-Client': '' },
    ];
    for (const headers of variants) {
      const gate = await clientPlane(
        request({ ...headers, Authorization: `Bearer sbu_${'a'.repeat(43)}` }),
        { requestId: 'r', route: 'GET /config', now: new Date() },
      );
      expect('refusal' in gate && (await codeOf(gate.refusal))).toMatchObject({
        status: 400,
        code: 'invalid_request',
        field: 'ShipBlu-Client',
      });
    }
    expect(lookup.calls).toBe(0);
  });

  it('answers 401 for no bearer without reading anything', async () => {
    const gate = await clientPlane(request(CLIENT), {
      requestId: 'r',
      route: 'GET /config',
      now: new Date(),
    });
    expect('refusal' in gate && (await codeOf(gate.refusal))).toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect(lookup.calls).toBe(0);
  });

  it('says whether the bearer was missing or malformed, reading nothing for either', async () => {
    const cases: [string | undefined, string][] = [
      [undefined, 'An Authorization bearer is required.'],
      ['Bearer not a token', 'Authorization must be `Bearer <token>`.'],
      ['Basic Zm9vOmJhcg==', 'Authorization must be `Bearer <token>`.'],
      [lookup.live, 'Authorization must be `Bearer <token>`.'],
    ];
    for (const [authorization, message] of cases) {
      const gate = await clientPlane(
        request(authorization === undefined ? CLIENT : { ...CLIENT, Authorization: authorization }),
        { requestId: 'r', route: 'GET /config', now: new Date() },
      );
      const refused = 'refusal' in gate ? await codeOf(gate.refusal) : null;
      expect(refused, String(authorization)).toMatchObject({
        status: 401,
        code: 'unauthenticated',
        message,
      });
      expect(refused?.message).not.toContain('Zm9v');
      expect(refused?.message).not.toContain(lookup.live);
    }
    expect(lookup.calls).toBe(0);

    const unknown = await clientPlane(
      request({ ...CLIENT, Authorization: `Bearer sbu_${'z'.repeat(43)}` }),
      { requestId: 'r', route: 'GET /config', now: new Date() },
    );
    expect('refusal' in unknown && (await codeOf(unknown.refusal))).toMatchObject({
      status: 401,
      message: 'No live session for this bearer.',
    });
  });

  it("refuses a blocked contact's session with 403 blocked", async () => {
    const gate = await clientPlane(
      request({ ...CLIENT, Authorization: `Bearer ${lookup.blocked}` }),
      { requestId: 'r', route: 'GET /config', now: new Date() },
    );
    expect('refusal' in gate && (await codeOf(gate.refusal))).toMatchObject({
      status: 403,
      code: 'blocked',
    });
  });

  // A console or portal cookie is not a credential here: nothing reads one.
  it('answers 401 to a request carrying cookies and no bearer', async () => {
    const gate = await clientPlane(
      request({ ...CLIENT, Cookie: 'shipblu_session=abc; shipblu_customer=def' }),
      { requestId: 'r', route: 'GET /config', now: new Date() },
    );
    expect('refusal' in gate && (await codeOf(gate.refusal))).toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });
  it('answers 429 past 120 refused bearers from one address, and still lets a live session through', async () => {
    // A carrier's egress, shared by many apps; anybody can write it into X-Forwarded-For.
    const from = '41.33.0.1';
    const asking = (bearer: string) =>
      clientPlane(
        new Request('https://x/api/v1/config', {
          headers: { ...CLIENT, 'x-forwarded-for': from, Authorization: `Bearer ${bearer}` },
        }),
        { requestId: 'r', route: 'GET /config', now: new Date() },
      );
    for (let i = 0; i < 120; i += 1) {
      const gate = await asking('nope');
      expect('refusal' in gate && gate.refusal.status).toBe(401);
    }

    const refused = await asking('nope');
    expect('refusal' in refused && (await codeOf(refused.refusal))).toMatchObject({
      status: 429,
      code: 'rate_limited',
    });

    // The spent budget changes a refusal's status and refuses nobody: the
    // session is read, and a live one goes on.
    const before = lookup.calls;
    expect(await asking(lookup.live)).toEqual({
      caller: expect.objectContaining({ identityId: 'i' }),
    });
    expect(lookup.calls).toBe(before + 1);
  });
});

describe('the client plane and a forged address', () => {
  // The address is the first X-Forwarded-For value, which anybody writes. Read
  // after the session, it refuses nobody who presents a live one: twelve
  // hundred forged requests under a carrier's egress once refused every app
  // behind it for the rest of the minute, sign-outs included.
  it('reads the session before counting the address, so a flood under it refuses no live session', async () => {
    const from = '41.33.0.2';
    const asking = (headers: Record<string, string>) =>
      new Request('https://x/api/v1/config', {
        headers: { ...CLIENT, 'x-forwarded-for': from, ...headers },
      });
    for (let i = 0; i < 1_300; i += 1) {
      await clientPlane(asking({ Authorization: `Bearer ${lookup.live}` }), {
        requestId: 'r',
        route: 'GET /config',
        now: new Date(),
      });
    }
    expect(
      await clientPlane(asking({ Authorization: `Bearer ${lookup.live}` }), {
        requestId: 'r',
        route: 'GET /config',
        now: new Date(),
      }),
    ).toEqual({ caller: expect.objectContaining({ identityId: 'i' }) });
    expect(
      await endingPlane(asking({ Authorization: `Bearer ${lookup.live}` }), {
        requestId: 'r',
        route: 'DELETE /session',
        now: new Date(),
      }),
    ).toEqual({ ending: { tokenHash: 'h', identityId: 'i' } });
  });
});

describe('endingPlane', () => {
  const ending = (headers: Record<string, string>) =>
    endingPlane(request(headers), { requestId: 'r', route: 'DELETE /session', now: new Date() });

  // `DELETE /session` ends a blocked contact's session rather than leaving it
  // live for whenever the block is lifted.
  it("hands back a live session's hash and a blocked contact's alike", async () => {
    expect(await ending({ ...CLIENT, Authorization: `Bearer ${lookup.live}` })).toEqual({
      ending: { tokenHash: 'h', identityId: 'i' },
    });
    expect(await ending({ ...CLIENT, Authorization: `Bearer ${lookup.blocked}` })).toEqual({
      ending: { tokenHash: 'hb', identityId: 'ib' },
    });
  });

  // A refusal here would leave the session live for the rest of its day: the
  // app's sign-out wipes the device whatever it is answered.
  it('ends the session of a build too old to be served, which every other route answers 426', async () => {
    const minimums = MINIMUM_VERSIONS as Map<string, string>;
    minimums.set('sdk-ts', '9.0.0');
    try {
      const gate = await clientPlane(
        request({ ...CLIENT, Authorization: `Bearer ${lookup.live}` }),
        { requestId: 'r', route: 'GET /config', now: new Date() },
      );
      expect('refusal' in gate ? await codeOf(gate.refusal) : null).toMatchObject({
        status: 426,
        code: 'client_upgrade_required',
      });
      expect(await ending({ ...CLIENT, Authorization: `Bearer ${lookup.live}` })).toEqual({
        ending: { tokenHash: 'h', identityId: 'i' },
      });
    } finally {
      minimums.delete('sdk-ts');
    }
  });

  // The header is judged only to decide a `426`, which ending never answers,
  // so a build that sends none, or one this server no longer parses, still
  // ends its session rather than being refused and leaving it live.
  it('judges no ShipBlu-Client, missing or unparsable', async () => {
    const variants: Record<string, string>[] = [
      {},
      { 'ShipBlu-Client': 'my app' },
      { 'ShipBlu-Client': '' },
    ];
    for (const headers of variants) {
      expect(await ending({ ...headers, Authorization: `Bearer ${lookup.blocked}` })).toEqual({
        ending: { tokenHash: 'hb', identityId: 'ib' },
      });
    }
  });

  it('refuses everything else as the client plane does', async () => {
    const refused = async (gate: Awaited<ReturnType<typeof ending>>) =>
      'refusal' in gate ? await codeOf(gate.refusal) : null;

    expect(await refused(await ending({ ...CLIENT }))).toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect(
      await refused(await ending({ ...CLIENT, Authorization: `Bearer sbu_${'z'.repeat(43)}` })),
    ).toMatchObject({ status: 401, code: 'unauthenticated' });

    setTestEnv({ MYBLU_API_TOKEN: undefined });
    expect(
      await refused(await ending({ ...CLIENT, Authorization: `Bearer ${lookup.blocked}` })),
    ).toMatchObject({ status: 503, code: 'not_configured' });
  });
});

describe('belowMinimum', () => {
  it('refuses nothing while no minimum is set', () => {
    expect(belowMinimum('sdk-ts/0.0.1 app/1.0.0 ios/12.0')).toBeNull();
  });

  it('names the first token older than its minimum, and judges no other name', () => {
    const minimums = new Map([
      ['sdk-ts', '0.2.0'],
      ['app', '5.4'],
    ]);
    expect(belowMinimum('sdk-ts/0.1.9 app/5.4.1 ios/18.1', minimums)).toBe('sdk-ts/0.1.9');
    expect(belowMinimum('sdk-ts/0.2.0 app/5.3.9 ios/18.1', minimums)).toBe('app/5.3.9');
    expect(belowMinimum('sdk-ts/0.10.0 app/5.4 ios/1.0', minimums)).toBeNull();
    // A pre-release comes before its release; a version with no numbers is
    // older than any.
    expect(belowMinimum('sdk-ts/0.2.0-beta.1 app/6.0.0', minimums)).toBe('sdk-ts/0.2.0-beta.1');
    expect(belowMinimum('sdk-ts/0.2.1-beta.1 app/6.0.0', minimums)).toBeNull();
    expect(belowMinimum('sdk-ts/dev app/6.0.0', minimums)).toBe('sdk-ts/dev');
    expect(belowMinimum('sdk-swift/0.0.1 app/6.0.0', minimums)).toBeNull();
  });

  // The SDK's first version is `1.0.0-rc.1`. Read by its numbers alone it was
  // `1.0.0`, so a minimum of `1.0.0` retired no candidate, and `1.0.1`, the one
  // that did, refused `1.0.0` too.
  it('retires the release candidates with the release they lead to', () => {
    const minimums = new Map([['sdk-ts', '1.0.0']]);
    expect(belowMinimum('sdk-ts/1.0.0-rc.1 app/5.4.1', minimums)).toBe('sdk-ts/1.0.0-rc.1');
    expect(belowMinimum('sdk-ts/1.0.0-rc.9 app/5.4.1', minimums)).toBe('sdk-ts/1.0.0-rc.9');
    expect(belowMinimum('sdk-ts/1.0.0 app/5.4.1', minimums)).toBeNull();
    expect(belowMinimum('sdk-ts/1.0.1-rc.1 app/5.4.1', minimums)).toBeNull();
    // Build metadata is not read.
    expect(belowMinimum('sdk-ts/1.0.0+42 app/5.4.1', minimums)).toBeNull();
    expect(belowMinimum('sdk-ts/1.0.0-rc.1+42 app/5.4.1', minimums)).toBe('sdk-ts/1.0.0-rc.1+42');
  });

  it('orders two pre-releases of one release as semver does', () => {
    const atRc2 = new Map([['sdk-ts', '1.0.0-rc.2']]);
    expect(belowMinimum('sdk-ts/1.0.0-rc.1', atRc2)).toBe('sdk-ts/1.0.0-rc.1');
    expect(belowMinimum('sdk-ts/1.0.0-rc.2', atRc2)).toBeNull();
    // Numbers by value, not as text.
    expect(belowMinimum('sdk-ts/1.0.0-rc.10', atRc2)).toBeNull();
    expect(belowMinimum('sdk-ts/1.0.0', atRc2)).toBeNull();
    expect(belowMinimum('sdk-ts/0.9.0', atRc2)).toBe('sdk-ts/0.9.0');

    // 1.0.0-1 < 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta: a number before a
    // word, the shorter of two that agree first, words in ASCII order.
    const atAlpha1 = new Map([['sdk-ts', '1.0.0-alpha.1']]);
    expect(belowMinimum('sdk-ts/1.0.0-1', atAlpha1)).toBe('sdk-ts/1.0.0-1');
    expect(belowMinimum('sdk-ts/1.0.0-alpha', atAlpha1)).toBe('sdk-ts/1.0.0-alpha');
    expect(belowMinimum('sdk-ts/1.0.0-alpha.1', atAlpha1)).toBeNull();
    expect(belowMinimum('sdk-ts/1.0.0-beta', atAlpha1)).toBeNull();
  });
});
