import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import {
  agents,
  apiSessions,
  channels,
  contactIdentities,
  contactSessions,
  contacts,
  sessions,
} from '@/db/schema';
import { ErrorBody, Config, Session } from '@/lib/api/schemas';
import {
  deleteSweptApiSessions,
  endStatement,
  lookupSession,
  mintSession,
  revokeSessions,
  revokeStatement,
} from '@/lib/api/sessions';
import { generateToken, hashToken } from '@/lib/auth/tokens';
import { mergeContacts } from '@/lib/contacts/merge';
import { resetEnvCache } from '@/lib/env';
import { withCleanDatabase } from '@/lib/testing/db';
import { holdNextTransaction, untilWaitingOnALock } from '@/lib/testing/hold-transaction';
import { resolveContact } from '@/lib/tickets/contacts';
import { GET as getConfig } from './config/route';
import { DELETE as deleteSession } from './session/route';
import { POST as postRevoke } from './sessions/revoke/route';
import { POST as postSession } from './sessions/route';

/**
 * The myBlu API's four session routes against Postgres
 * (`plans/myblu-ticket-api.md`, stage 3): minting on the server plane, the
 * session the client plane then presents, and every way one is refused.
 */

withCleanDatabase();

const TOKEN = 'db-test-myblu-api-token-0123456789-abcdef';
const PREVIOUS = 'db-test-myblu-api-previous-0123456789-abc';
const CLIENT = 'sdk-ts/0.1.0 app/5.4.1 ios/18.1';
const PHONE = '+201001234567';

/**
 * Each test's own user, so the minting bucket — in memory, ten in ten minutes
 * for one `externalUserId`, and kept for the whole file — is never one an
 * earlier test spent.
 */
let user = '';
let seq = 0;

beforeEach(() => {
  user = `u_${(seq += 1)}`;
  vi.stubEnv('MYBLU_API_TOKEN', TOKEN);
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

function setToken(name: 'MYBLU_API_TOKEN' | 'MYBLU_API_TOKEN_PREVIOUS', value: string | undefined) {
  vi.stubEnv(name, value);
  resetEnvCache();
}

let next = 0;
/** A fresh documentation address per request, so one test's buckets are never another's. */
const address = () => `198.51.100.${(next += 1) % 250}-${next}`;

function serverRequest(path: string, body: unknown, bearer: string = TOKEN): Request {
  return new Request(`https://support.shipblu.com/api/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      'x-forwarded-for': address(),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function clientRequest(
  path: string,
  {
    method = 'GET',
    token,
    headers = {},
  }: { method?: string; token?: string; headers?: Record<string, string> } = {},
): Request {
  return new Request(`https://support.shipblu.com/api/v1${path}`, {
    method,
    headers: {
      'ShipBlu-Client': CLIENT,
      'x-forwarded-for': address(),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
  });
}

const mintBody = (externalUserId = user, phone = PHONE) => ({
  externalUserId,
  phone,
  name: 'Nour Adel',
  client: { platform: 'ios', appVersion: '5.4.1' },
});

/** A session minted through the route, as myBlu's backend would. */
async function minted(externalUserId = user, phone = PHONE): Promise<string> {
  const response = await postSession(serverRequest('/sessions', mintBody(externalUserId, phone)));
  expect(response.status).toBe(201);
  return Session.parse(await response.json()).token;
}

const config = (token?: string, headers?: Record<string, string>) =>
  getConfig(clientRequest('/config', { token, headers }));

async function refusal(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = ErrorBody.parse(await response.json());
  expect(body.error.requestId).toBe(response.headers.get('shipblu-request-id'));
  return { status: response.status, ...body.error };
}

async function rows() {
  return db.select().from(apiSessions);
}

async function identityId(externalUserId = user): Promise<string> {
  const [row] = await db
    .select({ id: contactIdentities.id })
    .from(contactIdentities)
    .where(
      and(
        eq(contactIdentities.channel, 'api'),
        eq(contactIdentities.identifier, `myblu:${externalUserId}`),
      ),
    );
  return row!.id;
}

async function contactOf(externalUserId = user): Promise<string> {
  const [row] = await db
    .select({ contactId: contactIdentities.contactId })
    .from(contactIdentities)
    .where(eq(contactIdentities.identifier, `myblu:${externalUserId}`));
  return row!.contactId;
}

describe('POST /sessions', () => {
  it('mints a token stored only as its hash, for twenty-four hours, with the headers every answer carries', async () => {
    const before = Date.now();
    const response = await postSession(serverRequest('/sessions', mintBody()));

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('shipblu-request-id')).toMatch(/^[0-9a-f-]{36}$/);

    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'expiresInSeconds', 'token']);
    const session = Session.parse(body);
    expect(session.token).toMatch(/^sbu_[A-Za-z0-9_-]{43}$/);
    expect(session.expiresInSeconds).toBe(86_400);
    const expiresAt = Date.parse(session.expiresAt);
    expect(expiresAt - before).toBeGreaterThanOrEqual(86_400_000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(86_400_000);

    const [row] = await rows();
    expect(row).toMatchObject({
      tokenHash: hashToken(session.token),
      identityId: await identityId(),
      phone: '201001234567',
      platform: 'ios',
      appVersion: '5.4.1',
      revokedAt: null,
      revokeReason: null,
    });
    expect(row!.expiresAt.toISOString()).toBe(session.expiresAt);
    expect(JSON.stringify(row)).not.toContain(session.token);
  });

  it('records the forwarded chain, not only the hop a caller wrote', async () => {
    // The first hop is the caller's to write — the backend's own address, by
    // somebody holding a leaked token — and the one after it is what the
    // platform's proxy saw connect.
    const request = serverRequest('/sessions', mintBody());
    request.headers.set('x-forwarded-for', '198.51.100.1, 203.0.113.9');
    expect((await postSession(request)).status).toBe(201);

    const [row] = await rows();
    expect(row!.forwardedFor).toBe('198.51.100.1, 203.0.113.9');
  });

  it('mints a new token on every call', async () => {
    expect(await minted()).not.toBe(await minted());
    expect(await rows()).toHaveLength(2);
  });

  it('accepts MYBLU_API_TOKEN_PREVIOUS beside the current value', async () => {
    setToken('MYBLU_API_TOKEN_PREVIOUS', PREVIOUS);
    const response = await postSession(serverRequest('/sessions', mintBody(), PREVIOUS));
    expect(response.status).toBe(201);
  });

  it('refuses a bearer that is neither value, and a session token, as unauthenticated', async () => {
    const token = await minted();
    for (const bearer of ['not-the-token', token, `${TOKEN}x`]) {
      expect(
        await refusal(await postSession(serverRequest('/sessions', mintBody(), bearer))),
      ).toMatchObject({ status: 401, code: 'unauthenticated' });
    }
    expect(await rows()).toHaveLength(1);
  });

  it('refuses a national-format phone as invalid_request on `phone`, and writes nothing', async () => {
    for (const phone of ['01001234567', '201001234567', '+2010012', '+01001234567']) {
      const response = await postSession(serverRequest('/sessions', mintBody('u_1', phone)));
      const error = await refusal(response);
      expect(error).toMatchObject({ status: 400, code: 'invalid_request', field: 'phone' });
      // The developer's sentence never repeats what was sent.
      expect(error.message).not.toContain(phone);
    }
    expect(await rows()).toEqual([]);
    expect(await db.select({ id: contacts.id }).from(contacts)).toEqual([]);
  });

  it('refuses an externalUserId with anything around it rather than trimming it', async () => {
    for (const externalUserId of [' u_1', 'u_1 ', '', 'u/1', 'x'.repeat(129)]) {
      const response = await postSession(serverRequest('/sessions', mintBody(externalUserId)));
      expect(await refusal(response)).toMatchObject({
        status: 400,
        code: 'invalid_request',
        field: 'externalUserId',
      });
    }
    expect(await rows()).toEqual([]);
  });

  it('names the nested field, refuses a body that is not JSON, and ignores fields it does not know', async () => {
    const platform = await postSession(
      serverRequest('/sessions', { ...mintBody(), client: { platform: 'web', appVersion: '1' } }),
    );
    expect(await refusal(platform)).toMatchObject({ status: 400, field: 'client.platform' });

    const notJson = await refusal(await postSession(serverRequest('/sessions', '{not json')));
    expect(notJson).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(notJson.field).toBeUndefined();

    const extra = await postSession(serverRequest('/sessions', { ...mintBody(), later: true }));
    expect(extra.status).toBe(201);
  });

  // Postgres's `text` refuses U+0000 (22021): let through, the mint rolled
  // back and answered 500, which a backend retrying can never get past.
  it('refuses U+0000 in the name or the app version as invalid_request on that field, and writes nothing', async () => {
    const bodies: [string, unknown][] = [
      ['name', { ...mintBody(), name: 'Mu\u0000Null' }],
      [
        'client.appVersion',
        { ...mintBody(), client: { platform: 'ios', appVersion: '5.4\u0000' } },
      ],
    ];
    for (const [field, body] of bodies) {
      const error = await refusal(await postSession(serverRequest('/sessions', body)));
      expect(error).toMatchObject({ status: 400, code: 'invalid_request', field });
    }
    expect(await rows()).toEqual([]);
    expect(await db.select({ id: contacts.id }).from(contacts)).toEqual([]);

    // The same body without it mints, so the refusal was the character's.
    expect((await postSession(serverRequest('/sessions', mintBody()))).status).toBe(201);
  });

  it('refuses a blocked contact with 403 blocked and writes no session', async () => {
    const { contactId } = await resolveContact({ channel: 'whatsapp', identifier: '201001234567' });
    await db.update(contacts).set({ isBlocked: true }).where(eq(contacts.id, contactId));

    const response = await postSession(serverRequest('/sessions', mintBody()));
    expect(await refusal(response)).toMatchObject({ status: 403, code: 'blocked' });
    expect(await rows()).toEqual([]);
  });

  it('refuses the eleventh mint for one user in ten minutes, with Retry-After', async () => {
    for (let i = 0; i < 10; i += 1) await minted('u_busy');
    const response = await postSession(serverRequest('/sessions', mintBody('u_busy')));
    expect(await refusal(response)).toMatchObject({ status: 429, code: 'rate_limited' });
    const retryAfter = Number(response.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(600);

    // Another user's budget is their own.
    expect((await postSession(serverRequest('/sessions', mintBody('u_other')))).status).toBe(201);
  });

  it('logs the identity and the route, and nothing the body carried', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const token = await minted('u_private');
      const line = lines.find((l) => l.includes('session minted'));
      expect(line).toContain(`identity=${await identityId('u_private')}`);
      expect(line).toContain('route=POST /sessions');
      for (const secret of [token, 'u_private', '201001234567', 'Nour Adel', TOKEN]) {
        expect(lines.join('\n')).not.toContain(secret);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the API switched off', () => {
  it('answers 503 on both planes while MYBLU_API_TOKEN is unset', async () => {
    const token = await minted();
    setToken('MYBLU_API_TOKEN', undefined);
    setToken('MYBLU_API_TOKEN_PREVIOUS', PREVIOUS);

    for (const response of [
      await postSession(serverRequest('/sessions', mintBody())),
      await postSession(serverRequest('/sessions', mintBody(), PREVIOUS)),
      await postRevoke(
        serverRequest('/sessions/revoke', { externalUserId: 'u_1', reason: 'other' }),
      ),
      await config(token),
      await deleteSession(clientRequest('/session', { method: 'DELETE', token })),
    ]) {
      expect(await refusal(response)).toMatchObject({ status: 503, code: 'not_configured' });
    }
  });

  it('counts a MYBLU_API_TOKEN under 32 characters as unset', async () => {
    const token = await minted();
    const short = TOKEN.slice(0, 31);
    setToken('MYBLU_API_TOKEN', short);

    expect(
      await refusal(await postSession(serverRequest('/sessions', mintBody(), short))),
    ).toMatchObject({ status: 503, code: 'not_configured' });
    expect(await refusal(await config(token))).toMatchObject({
      status: 503,
      code: 'not_configured',
    });
  });
});

describe('GET /config', () => {
  it('answers who the session belongs to and what the server allows, and nothing more', async () => {
    const token = await minted();
    const response = await config(token);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('shipblu-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = (await response.json()) as Record<string, unknown>;
    Config.parse(body);
    // `support` is absent, not null, until stage 5.
    expect(Object.keys(body).sort()).toEqual(['limits', 'polling', 'tickets', 'user']);
    expect(body).toMatchObject({
      user: { id: await identityId(), externalId: user },
      tickets: { canCreate: false, maxOpen: 10 },
      limits: {
        messageMaxChars: 5000,
        maxFiles: 5,
        maxFileBytes: 26_214_400,
        maxTotalBytes: 26_214_400,
      },
      polling: { threadSeconds: 5, listSeconds: 30 },
    });
    const limits = body.limits as { contentTypes: string[]; extensions: string[] };
    expect(limits.contentTypes).toContain('image/heic');
    expect(limits.extensions).toContain('m4a');
  });

  it('says a ticket can be opened while an api row is on, and not once it is off', async () => {
    const token = await minted();
    const [row] = await db
      .insert(channels)
      .values({ type: 'api', name: 'myBlu app', config: {} })
      .returning({ id: channels.id });
    expect(Config.parse(await (await config(token)).json()).tickets.canCreate).toBe(true);

    await db.update(channels).set({ isActive: false }).where(eq(channels.id, row!.id));
    expect(Config.parse(await (await config(token)).json()).tickets.canCreate).toBe(false);
  });

  it('requires ShipBlu-Client', async () => {
    const token = await minted();
    const response = await getConfig(
      new Request('https://support.shipblu.com/api/v1/config', {
        headers: { Authorization: `Bearer ${token}`, 'x-forwarded-for': address() },
      }),
    );
    expect(await refusal(response)).toMatchObject({
      status: 400,
      code: 'invalid_request',
      field: 'ShipBlu-Client',
    });
  });

  it('refuses no bearer, a malformed one and an unknown one as unauthenticated', async () => {
    for (const token of [undefined, 'garbage', `sbu_${'a'.repeat(43)}`]) {
      expect(await refusal(await config(token))).toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
    }
  });

  // `/api/v1` never reads a cookie: a browser signed in to the console or the
  // portal and holding no bearer is nobody here.
  it('refuses a valid console cookie and a valid portal cookie with no bearer', async () => {
    const [agent] = await db
      .insert(agents)
      .values({ name: 'Agent', email: 'agent@shipblu.com', role: 'admin' })
      .returning({ id: agents.id });
    const consoleToken = generateToken();
    await db.insert(sessions).values({
      tokenHash: hashToken(consoleToken),
      agentId: agent!.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const response = await config(undefined, { Cookie: `shipblu_session=${consoleToken}` });
    expect(await refusal(response)).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it("refuses a portal session's token, as it is and with the prefix in front of it", async () => {
    const { contactId } = await resolveContact({
      channel: 'email',
      identifier: 'nour@example.com',
    });
    const [identity] = await db
      .select({ id: contactIdentities.id })
      .from(contactIdentities)
      .where(eq(contactIdentities.contactId, contactId));
    const portalToken = generateToken();
    await db.insert(contactSessions).values({
      tokenHash: hashToken(portalToken),
      identityId: identity!.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    for (const token of [portalToken, `sbu_${portalToken}`]) {
      expect(await refusal(await config(token))).toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
    }
    const cookie = await config(undefined, { Cookie: `shipblu_customer=${portalToken}` });
    expect((await refusal(cookie)).status).toBe(401);
  });

  it('answers session_expired for a session past its day', async () => {
    const outcome = await mintSession({
      externalUserId: 'u_old',
      phone: '201001234567',
      name: null,
      platform: 'android',
      appVersion: '5.4.1',
      forwardedFor: null,
      now: new Date(Date.now() - 25 * 3_600_000),
    });
    if (outcome.kind !== 'minted') throw new Error('expected a session');
    expect(await refusal(await config(outcome.token))).toMatchObject({
      status: 401,
      code: 'session_expired',
    });
  });

  it("reads the contact through the identity on every request: a block is the next request's answer", async () => {
    const token = await minted();
    expect((await config(token)).status).toBe(200);

    await db
      .update(contacts)
      .set({ isBlocked: true })
      .where(eq(contacts.id, await contactOf()));
    expect(await refusal(await config(token))).toMatchObject({ status: 403, code: 'blocked' });
  });

  it('follows the identity through a contact merge, keeping user.id', async () => {
    const token = await minted();
    const loser = await contactOf();
    const [survivor] = await db
      .insert(contacts)
      .values({ name: 'The same person' })
      .returning({ id: contacts.id });

    const merged = await mergeContacts({ survivorId: survivor!.id, loserId: loser, agentId: null });
    expect(merged.ok).toBe(true);
    expect(await contactOf()).toBe(survivor!.id);

    const answer = Config.parse(await (await config(token)).json());
    expect(answer.user.id).toBe(await identityId());

    await db.update(contacts).set({ isBlocked: true }).where(eq(contacts.id, survivor!.id));
    expect((await config(token)).status).toBe(403);
  });

  it('refuses the 241st read in a minute for one user, with Retry-After', async () => {
    const token = await minted();
    for (let i = 0; i < 240; i += 1) expect((await config(token)).status).toBe(200);
    const refused = await config(token);
    expect(await refusal(refused)).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
});

describe('DELETE /session', () => {
  it('ends the presented session and nothing else', async () => {
    const thisDevice = await minted();
    const otherDevice = await minted();

    const response = await deleteSession(
      clientRequest('/session', { method: 'DELETE', token: thisDevice }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('shipblu-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.text()).toBe('');

    expect(await refusal(await config(thisDevice))).toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect((await config(otherDevice)).status).toBe(200);

    const [ended] = await db
      .select()
      .from(apiSessions)
      .where(eq(apiSessions.tokenHash, hashToken(thisDevice)));
    expect(ended).toMatchObject({ revokeReason: 'ended' });
    expect(ended!.revokedAt).not.toBeNull();
  });

  // Refused, a blocked contact's session stayed live for the rest of its
  // day, and lifting the block brought back a token the app had wiped.
  it.each([
    ['blocked', { isBlocked: true }],
    ['deleted', { deletedAt: new Date() }],
  ] as const)(
    "ends a %s contact's session and answers 204, so lifting it brings nothing back",
    async (_, set) => {
      const token = await minted();
      const contactId = await contactOf();
      await db.update(contacts).set(set).where(eq(contacts.id, contactId));
      expect(await refusal(await config(token))).toMatchObject({ status: 403, code: 'blocked' });

      const response = await deleteSession(clientRequest('/session', { method: 'DELETE', token }));
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');

      const [ended] = await db
        .select()
        .from(apiSessions)
        .where(eq(apiSessions.tokenHash, hashToken(token)));
      expect(ended).toMatchObject({ revokeReason: 'ended' });
      expect(ended!.revokedAt).not.toBeNull();

      await db
        .update(contacts)
        .set({ isBlocked: false, deletedAt: null })
        .where(eq(contacts.id, contactId));
      expect(await refusal(await config(token))).toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
    },
  );
});

describe('POST /sessions/revoke', () => {
  it("records the reason on every live session of that user and on nobody else's", async () => {
    const one = await minted();
    const two = await minted();
    const someoneElse = await minted('u_other', '+201112223334');

    const response = await postRevoke(
      serverRequest('/sessions/revoke', { externalUserId: user, reason: 'phone_changed' }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');

    for (const token of [one, two]) {
      expect(await refusal(await config(token))).toMatchObject({
        status: 401,
        code: 'unauthenticated',
      });
    }
    expect((await config(someoneElse)).status).toBe(200);

    const reasons = (
      await db
        .select({ reason: apiSessions.revokeReason })
        .from(apiSessions)
        .where(eq(apiSessions.identityId, await identityId()))
    ).map((row) => row.reason);
    expect(reasons).toEqual(['phone_changed', 'phone_changed']);

    // Revoked rows are kept, as the record of who was vouched for.
    expect(await rows()).toHaveLength(3);
  });

  it('leaves an earlier reason and an expired row as they were', async () => {
    const ended = await minted();
    await deleteSession(clientRequest('/session', { method: 'DELETE', token: ended }));
    await mintSession({
      externalUserId: user,
      phone: '201001234567',
      name: null,
      platform: 'ios',
      appVersion: '5.4.1',
      forwardedFor: null,
      now: new Date(Date.now() - 25 * 3_600_000),
    });

    await postRevoke(
      serverRequest('/sessions/revoke', { externalUserId: user, reason: 'account_deleted' }),
    );

    const reasons = (await db.select({ reason: apiSessions.revokeReason }).from(apiSessions))
      .map((row) => row.reason)
      .sort();
    expect(reasons).toEqual(['ended', null]);
  });

  it('answers 204 for a user it does not know, and writes nothing', async () => {
    const token = await minted();
    const response = await postRevoke(
      serverRequest('/sessions/revoke', { externalUserId: 'u_nobody', reason: 'signed_out' }),
    );
    expect(response.status).toBe(204);
    expect((await config(token)).status).toBe(200);
  });

  it('refuses a reason it does not know, naming the field', async () => {
    const response = await postRevoke(
      serverRequest('/sessions/revoke', { externalUserId: 'u_1', reason: 'because' }),
    );
    expect(await refusal(response)).toMatchObject({ status: 400, field: 'reason' });
  });

  it('refuses a session token as its bearer', async () => {
    const token = await minted();
    const response = await postRevoke(
      serverRequest('/sessions/revoke', { externalUserId: user, reason: 'other' }, token),
    );
    expect(await refusal(response)).toMatchObject({ status: 401, code: 'unauthenticated' });
  });
});

describe('a mint and a revoke for one account at once', () => {
  const direct = (externalUserId: string) =>
    mintSession({
      externalUserId,
      phone: '201001234567',
      name: null,
      platform: 'ios',
      appVersion: '5.4.1',
      forwardedFor: null,
      now: new Date(),
    });

  // The mint has written its session and not committed it when the revoke
  // runs. Without the account's lock the revoke's UPDATE could not see the row
  // and did not wait for it: 204, and a session that lived a day after a
  // "sign out everywhere".
  for (const [name, minted] of [
    ['an account that has minted before', true],
    ["an account's first mint, whose identity is not committed either", false],
  ] as const) {
    it(`revokes the session in flight, for ${name}`, async () => {
      if (minted) await direct(user);

      const held = holdNextTransaction('after');
      const minting = direct(user);
      await held.atHold;
      const revoking = revokeSessions(user, 'signed_out', new Date());
      expect(await untilWaitingOnALock(db)).toBe(true);
      held.release();

      const [late, revoked] = await Promise.all([minting, revoking]);
      if (late.kind !== 'minted') throw new Error('expected a session');
      expect(revoked.revoked).toBe(minted ? 2 : 1);
      expect(await lookupSession(late.token, new Date())).toEqual({ kind: 'unauthenticated' });
    });
  }

  it('orders a mint that comes after the revoke after it', async () => {
    await direct(user);
    const held = holdNextTransaction('after');
    const revoking = revokeSessions(user, 'signed_out', new Date());
    await held.atHold;
    const minting = direct(user);
    expect(await untilWaitingOnALock(db)).toBe(true);
    held.release();

    const [revoked, late] = await Promise.all([revoking, minting]);
    expect(revoked.revoked).toBe(1);
    if (late.kind !== 'minted') throw new Error('expected a session');
    expect((await lookupSession(late.token, new Date())).kind).toBe('live');
  });
});

describe('a contact merge during a mint', () => {
  // The mint read the account's identity and its contact before its
  // transaction; the merge re-points the identity and stamps that contact
  // deleted before the transaction reads it. Read by the old id, the account
  // was answered 403 blocked, which its SDK holds until the app restarts.
  it('mints on the survivor rather than refusing the account as blocked', async () => {
    const token = await minted();
    const loser = await contactOf();
    const [survivor] = await db
      .insert(contacts)
      .values({ name: 'The same person' })
      .returning({ id: contacts.id });

    const held = holdNextTransaction('before');
    const minting = mintSession({
      externalUserId: user,
      phone: '201001234567',
      name: null,
      platform: 'ios',
      appVersion: '5.4.1',
      forwardedFor: null,
      now: new Date(),
    });
    await held.atHold;
    expect(
      (await mergeContacts({ survivorId: survivor!.id, loserId: loser, agentId: null })).ok,
    ).toBe(true);
    held.release();

    const outcome = await minting;
    expect(outcome).toMatchObject({ kind: 'minted', identityId: await identityId() });
    expect(await contactOf()).toBe(survivor!.id);
    for (const live of [token, outcome.kind === 'minted' ? outcome.token : '']) {
      expect((await config(live)).status).toBe(200);
    }
  });
});

describe('the nightly sweep', () => {
  it('deletes a session thirty days after it ran out, and keeps one that ran out sooner', async () => {
    const day = 24 * 3_600_000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day);
    for (const [externalUserId, mintedDaysAgo] of [
      ['u_gone', 32],
      ['u_kept', 30],
    ] as const) {
      await mintSession({
        externalUserId,
        phone: '201001234567',
        name: null,
        platform: 'ios',
        appVersion: '5.4.1',
        forwardedFor: null,
        now: at(mintedDaysAgo),
      });
    }

    expect(await deleteSweptApiSessions()).toBe(1);
    const left = await rows();
    expect(left).toHaveLength(1);
    expect(left[0]!.identityId).toBe(await identityId('u_kept'));
  });
});

describe('the statements that stamp a session', () => {
  // AGENTS.md, _Tests_: an instant reaches Postgres as text behind a cast,
  // never as a bare Date postgres.js cannot serialise.
  it('bind no bare Date', () => {
    const now = new Date('2026-11-13T09:00:00.000Z');
    for (const { params } of [
      endStatement(hashToken('x'), now).toSQL(),
      revokeStatement(db, '00000000-0000-0000-0000-000000000000', 'other', now).toSQL(),
    ]) {
      expect(params.some((param) => param instanceof Date)).toBe(false);
      expect(params).toContain(now.toISOString());
    }
  });
});
