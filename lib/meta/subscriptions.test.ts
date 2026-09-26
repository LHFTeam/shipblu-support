import { beforeEach, describe, expect, it } from 'vitest';
import { stubFetch } from '@/lib/testing/fetch';
import { setTestEnv, withTestEnv } from '@/lib/testing/env';
import { GRAPH_BASE, INSTAGRAM_GRAPH_BASE } from './graph';
import {
  applyFieldSubscription,
  applyInstagramLoginSubscription,
  applyPageSubscription,
  type GraphSubscription,
  GraphSubscriptionError,
  INSTAGRAM_OBJECT,
  PAGE_OBJECT,
  planFieldSubscription,
  planInstagramLoginSubscription,
  planPageSubscription,
  readInstagramLoginSubscription,
  readPageSubscription,
  readSubscription,
  REQUIRED_INSTAGRAM_FIELDS,
  REQUIRED_PAGE_FIELDS,
  REQUIRED_WHATSAPP_FIELDS,
  resolveObject,
  WHATSAPP_OBJECT,
} from './subscriptions';

/**
 * The merge, not the Graph call, is what these cover.
 *
 * `POST /{app-id}/subscriptions` replaces the subscribed field list rather than
 * adding to it, and Meta answers a list that drops `messages` with a 200. So the
 * failure this guards against is silent and total — every inbound WhatsApp
 * message and delivery status stops arriving, and nothing anywhere reports an
 * error. Every case below is really the same assertion: whatever else happens,
 * what was subscribed stays subscribed.
 */

const subscription = (fields: string[], overrides: Partial<GraphSubscription> = {}) =>
  ({
    object: 'whatsapp_business_account',
    callback_url: 'https://support.shipblu.com/api/webhooks/whatsapp',
    active: true,
    fields: fields.map((name) => ({ name, version: 'v23.0' })),
    ...overrides,
  }) satisfies GraphSubscription;

describe('planFieldSubscription', () => {
  it('adds the missing field and keeps the one already there', () => {
    // An explicit want-list rather than REQUIRED_WHATSAPP_FIELDS, because that
    // constant no longer adds anything to a healthy subscription — see the test
    // below. What is covered here is the merge itself, which every object's
    // write goes through, so it has to keep working whether or not WhatsApp
    // currently wants a second field. `account_alerts` is a real field on this
    // object; the case is not worth writing against an invented name, which is
    // how a subscription list came to carry a field Graph rejects.
    const plan = planFieldSubscription(subscription(['messages']), ['messages', 'account_alerts']);

    expect(plan.adding).toEqual(['account_alerts']);
    expect(plan.merged).toEqual(['messages', 'account_alerts']);
  });

  it('asks WhatsApp for nothing it is not already subscribed to', () => {
    // The state since Meta discontinued `message_echoes`: the required list is
    // `messages` alone, so a healthy subscription needs no write at all. This
    // asserts the constant rather than the merge, and it is here so that adding
    // a field back to it is a decision somebody makes against a failing test
    // rather than one that rides along in a diff.
    const plan = planFieldSubscription(subscription(['messages']), REQUIRED_WHATSAPP_FIELDS);

    expect(plan.adding).toEqual([]);
    expect(plan.merged).toEqual(['messages']);
  });

  it('keeps fields nothing in this repo asks for', () => {
    // The dashboard has fields this code never reads — template approvals, phone
    // number quality. They are somebody's alerting and the write must not
    // silently cancel them. Driven with a want-list that genuinely adds
    // something, because a merge that adds nothing preserves the rest trivially
    // and would pass even if the preserving half were deleted.
    const plan = planFieldSubscription(
      subscription(['messages', 'message_template_status_update', 'phone_number_quality_update']),
      ['messages', 'account_alerts'],
    );

    expect(plan.merged).toContain('message_template_status_update');
    expect(plan.merged).toContain('phone_number_quality_update');
    expect(plan.merged).toContain('messages');
    expect(plan.merged).toContain('account_alerts');
  });

  it('is a no-op once everything is subscribed', () => {
    const plan = planFieldSubscription(
      subscription(['messages', 'message_echoes']),
      REQUIRED_WHATSAPP_FIELDS,
    );

    expect(plan.adding).toEqual([]);
    expect(plan.merged).toEqual(['messages', 'message_echoes']);
  });

  it('does not list a field twice', () => {
    const plan = planFieldSubscription(
      subscription(['message_echoes', 'messages']),
      REQUIRED_WHATSAPP_FIELDS,
    );

    expect(plan.merged).toHaveLength(2);
  });

  it('never drops a subscribed field, whatever it is asked for', () => {
    const existing = ['messages', 'account_update', 'security'];
    const plan = planFieldSubscription(subscription(existing), ['message_echoes']);

    for (const field of existing) expect(plan.merged).toContain(field);
  });

  it('reports the callback URL it will write back, not one it built', () => {
    const plan = planFieldSubscription(
      subscription(['messages'], { callback_url: 'https://override.example/hook' }),
      REQUIRED_WHATSAPP_FIELDS,
    );

    expect(plan.callbackUrl).toBe('https://override.example/hook');
  });

  it('refuses a subscription with no callback URL rather than inventing one', () => {
    expect(() =>
      planFieldSubscription(subscription(['messages'], { callback_url: '' }), [
        ...REQUIRED_WHATSAPP_FIELDS,
      ]),
    ).toThrow(GraphSubscriptionError);
  });

  it('restores messages to a subscription that has somehow lost it', () => {
    // Not a case to "fix" by dropping the write: the merge restores `messages`
    // because it is in REQUIRED_WHATSAPP_FIELDS, which is why that constant
    // lists a field nothing was expected to be missing. That is now the
    // constant's whole job, and this is the test that says so.
    const plan = planFieldSubscription(subscription([]), REQUIRED_WHATSAPP_FIELDS);

    expect(plan.adding).toEqual(['messages']);
    expect(plan.merged).toEqual(['messages']);
  });
});

describe('the Instagram object', () => {
  it('adds `comments` to an account that is already receiving messages', () => {
    // Which is exactly the state production is in: 2,341 Instagram deliveries
    // stored and not one of them a comment.
    const plan = planFieldSubscription(
      subscription(['messages'], {
        object: INSTAGRAM_OBJECT,
        callback_url: 'https://support.shipblu.com/api/webhooks/meta',
      }),
      REQUIRED_INSTAGRAM_FIELDS,
    );

    expect(plan.adding).toEqual([
      'comments',
      'messaging_postbacks',
      'messaging_referral',
      'message_reactions',
    ]);
    // Spelled out rather than compared against the constant under test: the
    // Instagram vocabulary takes `messaging_referral` and the Page's takes
    // `messaging_referrals`, and an assertion built from the same array would
    // pass with either typed into either list — while Graph rejects the whole
    // write over the one character.
    expect(plan.merged).toEqual([
      'messages',
      'comments',
      'messaging_postbacks',
      'messaging_referral',
      'message_reactions',
    ]);
  });

  it('refuses to write a list that would drop the messaging fields', () => {
    // The same guard the WhatsApp cases above cover, asserted on this object
    // too: Instagram DMs are the channel's live traffic, and an Instagram
    // comment feature that silently unsubscribed them would be a bad trade.
    const plan = planFieldSubscription(
      subscription(['messages', 'message_reactions', 'messaging_seen'], {
        object: INSTAGRAM_OBJECT,
      }),
      REQUIRED_INSTAGRAM_FIELDS,
    );

    expect(plan.merged).toContain('message_reactions');
    expect(plan.merged).toContain('messaging_seen');
  });
});

describe('resolveObject', () => {
  it('defaults to WhatsApp, which is what the job did before it took an object', () => {
    expect(resolveObject(undefined)).toBe(WHATSAPP_OBJECT);
    expect(resolveObject('')).toBe(WHATSAPP_OBJECT);
  });

  it('accepts the three objects this app subscribes to', () => {
    expect(resolveObject('instagram')).toBe('instagram');
    expect(resolveObject('page')).toBe('page');
    expect(resolveObject(WHATSAPP_OBJECT)).toBe(WHATSAPP_OBJECT);
  });

  it('refuses anything else by name rather than writing an empty field list', () => {
    // `npm run job --` payloads are typed at a shell against production, so a
    // typo must not reach `planFieldSubscription` with no fields to want.
    expect(() => resolveObject('instgram')).toThrow(GraphSubscriptionError);
    expect(() => resolveObject('instgram')).toThrow(/not a webhook object/);
  });
});

/**
 * The Page half, which is the half that was missing.
 *
 * A Page field is delivered only when it is subscribed at *both* the app level
 * and the Page level. Only the first was ever written, which is why `feed` sat
 * in `REQUIRED_PAGE_FIELDS` for weeks and delivered nothing at all — 0 of 4,503
 * `page` and `instagram` deliveries carried a `changes` entry. These cover the
 * same property as the app-level merge above, because the write has the same
 * shape and the same way of going wrong.
 */
describe('planInstagramLoginSubscription', () => {
  const IG_ACCOUNT = '17841448759001625';

  it('keeps a field the account already carries that this codebase does not know about', () => {
    // The whole reason this reads before it writes. The POST replaces the field
    // list, so an account somebody subscribed to `mentions` by hand in the
    // dashboard loses it the first time this job runs — silently, and reported
    // as success.
    const plan = planInstagramLoginSubscription(
      IG_ACCOUNT,
      ['messages', 'mentions'],
      REQUIRED_INSTAGRAM_FIELDS,
    );

    expect(plan.adding).toEqual([
      'comments',
      'messaging_postbacks',
      'messaging_referral',
      'message_reactions',
    ]);
    expect(plan.merged.slice(0, 2)).toEqual(['messages', 'mentions']);
    expect(plan.merged).toContain('mentions');
  });

  it('reports an account with no subscription at all', () => {
    /*
      Null against `[]` again, and it answers a different question here than it
      does on the Page: the direct connection's account-level subscription is
      the one thing the App Dashboard does not show, so an account that has
      never been subscribed looks identical to one whose permission is
      unapproved — right up to this line.
    */
    const plan = planInstagramLoginSubscription(IG_ACCOUNT, null, REQUIRED_INSTAGRAM_FIELDS);

    expect(plan.subscribed).toBe(false);
    expect(plan.current).toEqual([]);
    expect(plan.merged).toEqual([
      'messages',
      'comments',
      'messaging_postbacks',
      'messaging_referral',
      'message_reactions',
    ]);
  });

  it('is a no-op once every field is subscribed', () => {
    const plan = planInstagramLoginSubscription(
      IG_ACCOUNT,
      ['messages', 'comments', 'messaging_postbacks', 'messaging_referral', 'message_reactions'],
      REQUIRED_INSTAGRAM_FIELDS,
    );

    expect(plan.adding).toEqual([]);
    expect(plan.subscribed).toBe(true);
  });

  it('carries the Instagram account id through to the write', () => {
    // Meta's example addresses `/me`. Naming the id is what makes a token
    // pointing at the wrong account a refusal rather than a subscription
    // quietly written somewhere else.
    expect(
      planInstagramLoginSubscription(IG_ACCOUNT, [], REQUIRED_INSTAGRAM_FIELDS).accountId,
    ).toBe(IG_ACCOUNT);
  });
});

describe('planPageSubscription', () => {
  const PAGE = '101449698657189';

  it('adds feed while keeping the messaging fields already installed', () => {
    const plan = planPageSubscription(
      PAGE,
      ['messages', 'messaging_postbacks'],
      REQUIRED_PAGE_FIELDS,
    );

    expect(plan.adding).toEqual(['feed', 'messaging_referrals', 'message_reactions']);
    expect(plan.merged.slice(0, 2)).toEqual(['messages', 'messaging_postbacks']);
    // The field already installed survives, and is not added twice. Writing only
    // what this codebase knows about would silently unsubscribe whatever else
    // the Page carries.
    expect(plan.merged.filter((field) => field === 'messaging_postbacks')).toHaveLength(1);
  });

  it('reports an app that is not installed on the Page at all', () => {
    /*
      Null is not the same answer as `[]`, and this is the distinction that
      explains a channel which has never once worked: an app absent from the
      Page has never been able to receive an event, however correct the
      app-level subscription looked.
    */
    const plan = planPageSubscription(PAGE, null, REQUIRED_PAGE_FIELDS);

    expect(plan.installed).toBe(false);
    expect(plan.current).toEqual([]);
    expect(plan.merged).toEqual([
      'messages',
      'feed',
      'messaging_postbacks',
      'messaging_referrals',
      'message_reactions',
    ]);
  });

  it('distinguishes installed-with-nothing from not installed', () => {
    const plan = planPageSubscription(PAGE, [], REQUIRED_PAGE_FIELDS);

    expect(plan.installed).toBe(true);
    expect(plan.merged).toEqual([
      'messages',
      'feed',
      'messaging_postbacks',
      'messaging_referrals',
      'message_reactions',
    ]);
  });

  it('is a no-op once every field is on the Page', () => {
    // Re-running this job is the normal way to check it, so "nothing to add"
    // has to be reachable rather than a write that reorders the list.
    const plan = planPageSubscription(
      PAGE,
      ['messages', 'feed', 'messaging_postbacks', 'messaging_referrals', 'message_reactions'],
      REQUIRED_PAGE_FIELDS,
    );

    expect(plan.adding).toEqual([]);
    expect(plan.merged).toEqual([
      'messages',
      'feed',
      'messaging_postbacks',
      'messaging_referrals',
      'message_reactions',
    ]);
  });

  it('carries the page id through to the write', () => {
    expect(planPageSubscription(PAGE, [], REQUIRED_PAGE_FIELDS).pageId).toBe(PAGE);
  });
});

/**
 * The deadline governs reading the body as well as waiting for the status. A
 * deadline passing mid-body rejected with the signal's own reason — "The
 * operation was aborted due to timeout", naming no host — rather than the
 * error every caller here reports.
 */
describe('a Graph answer that stops arriving', () => {
  withTestEnv({ META_APP_ID: '123', META_PAGE_ACCESS_TOKEN: 'token' });

  beforeEach(() => {
    stubFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
              );
            },
          }),
          { status: 200 },
        ),
    );
  });

  it('fails as a subscription error that says the deadline passed', async () => {
    const failure = readPageSubscription('456');

    await expect(failure).rejects.toBeInstanceOf(GraphSubscriptionError);
    await expect(failure).rejects.toThrow('Graph API did not answer in 15s');
  });
});

/**
 * The three requests this module makes, as they go out and as they fail.
 *
 * Each level has its own node, its own credential and its own sentence for a
 * refusal, because Graph's own sentence rarely says which of those was wrong.
 * What they share is how the credential travels — a header, never the query
 * string, because the app token contains the app secret verbatim — and how a
 * refusal becomes a `GraphSubscriptionError`. These pin both before the three
 * copies of that code become one.
 */
describe('the Graph requests behind each level', () => {
  withTestEnv({
    META_APP_ID: '123',
    META_APP_SECRET: 'app-secret',
    META_VERIFY_TOKEN: 'verify-me',
    META_PAGE_ACCESS_TOKEN: 'page-token',
    INSTAGRAM_ACCESS_TOKEN: 'instagram-token',
  });

  const LEVELS = [
    {
      level: 'the app level',
      read: () => readSubscription(INSTAGRAM_OBJECT),
      write: () =>
        applyFieldSubscription({
          object: INSTAGRAM_OBJECT,
          callbackUrl: 'https://support.shipblu.com/api/webhooks/meta',
          current: ['messages'],
          merged: ['messages', 'comments'],
          adding: ['comments'],
        }),
      node: `${GRAPH_BASE}/123/subscriptions`,
      writes: {
        object: INSTAGRAM_OBJECT,
        callback_url: 'https://support.shipblu.com/api/webhooks/meta',
        fields: 'messages,comments',
        verify_token: 'verify-me',
        include_values: 'true',
      },
      bearer: '123|app-secret',
      host: 'Graph API',
      explains: null,
      unset: 'META_APP_SECRET',
    },
    {
      level: 'the Page',
      read: () => readPageSubscription('456'),
      write: () =>
        applyPageSubscription({
          pageId: '456',
          installed: true,
          current: ['messages'],
          merged: ['messages', 'feed'],
          adding: ['feed'],
        }),
      node: `${GRAPH_BASE}/456/subscribed_apps`,
      writes: { subscribed_fields: 'messages,feed' },
      bearer: 'page-token',
      host: 'Graph API',
      explains: 'This call needs a Page token whose person can MANAGE the Page',
      unset: 'META_PAGE_ACCESS_TOKEN',
    },
    {
      level: 'the direct Instagram connection',
      read: () => readInstagramLoginSubscription('789'),
      write: () =>
        applyInstagramLoginSubscription({
          accountId: '789',
          subscribed: true,
          current: ['messages'],
          merged: ['messages', 'comments'],
          adding: ['comments'],
        }),
      node: `${INSTAGRAM_GRAPH_BASE}/789/subscribed_apps`,
      writes: { subscribed_fields: 'messages,comments' },
      bearer: 'instagram-token',
      host: 'graph.instagram.com',
      explains: 'This call is addressed to graph.instagram.com and authenticated with',
      unset: 'INSTAGRAM_ACCESS_TOKEN',
    },
  ];

  describe.each(LEVELS)('$level', (level) => {
    it('reads its node with the credential in a header, not the URL', async () => {
      const fetch = stubFetch(() => Response.json({ data: [] }));

      await level.read();

      const [url, init] = fetch.mock.calls[0]!;
      const sent = new URL(String(url));
      expect(`${sent.origin}${sent.pathname}`).toBe(level.node);
      expect(init?.method).toBe('GET');
      expect([...sent.searchParams]).toEqual([]);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${level.bearer}`);
    });

    it('writes the merged field list as the query of one POST', async () => {
      const fetch = stubFetch(() => Response.json({ success: true }));

      await level.write();

      expect(fetch).toHaveBeenCalledOnce();
      const [url, init] = fetch.mock.calls[0]!;
      const sent = new URL(String(url));
      expect(`${sent.origin}${sent.pathname}`).toBe(level.node);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeUndefined();
      expect(Object.fromEntries(sent.searchParams)).toEqual(level.writes);
      expect(sent.searchParams.has('access_token')).toBe(false);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${level.bearer}`);
    });

    it("reports a refusal with Graph's own sentence, code and trace id", async () => {
      stubFetch(() =>
        Response.json(
          { error: { message: 'Invalid parameter', code: 100, fbtrace_id: 'trace-1' } },
          { status: 400 },
        ),
      );

      const error = await level.read().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(GraphSubscriptionError);
      expect(error).toMatchObject({ status: 400, code: 100, traceId: 'trace-1' });
      const message = (error as Error).message;
      if (level.explains === null) {
        expect(message).toBe('Invalid parameter');
      } else {
        expect(message.startsWith(`Invalid parameter\n\n${level.explains}`)).toBe(true);
      }
    });

    it('names the status when the refusal is not JSON', async () => {
      stubFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }));

      const error = await level.read().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(GraphSubscriptionError);
      expect(error).toMatchObject({ status: 502, code: null, traceId: null });
      expect((error as Error).message.split('\n')[0]).toBe('HTTP 502');
    });

    it('names the host it could not reach', async () => {
      stubFetch(() => {
        throw new TypeError('fetch failed');
      });

      const failure = level.read();

      await expect(failure).rejects.toBeInstanceOf(GraphSubscriptionError);
      await expect(failure).rejects.toThrow(`${level.host} unreachable: fetch failed`);
    });

    it('refuses before sending anything when its credential is not set', async () => {
      setTestEnv({ [level.unset]: undefined });
      const fetch = stubFetch(() => Response.json({ data: [] }));

      await expect(level.read()).rejects.toThrow(level.unset);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('picks this app out of every subscription the app level reports', async () => {
    stubFetch(() =>
      Response.json({
        data: [
          { object: PAGE_OBJECT, callback_url: 'https://a', active: true, fields: [] },
          { object: INSTAGRAM_OBJECT, callback_url: 'https://b', active: true, fields: [] },
        ],
      }),
    );

    expect((await readSubscription(INSTAGRAM_OBJECT))?.callback_url).toBe('https://b');
  });

  it('picks this app out of every app installed on the Page', async () => {
    stubFetch(() =>
      Response.json({
        data: [
          { id: '999', subscribed_fields: ['feed'] },
          { id: '123', subscribed_fields: ['messages'] },
        ],
      }),
    );

    expect(await readPageSubscription('456')).toEqual(['messages']);
  });

  it('unions every entry the direct connection reports', async () => {
    stubFetch(() =>
      Response.json({
        data: [
          { subscribed_fields: ['messages'] },
          { subscribed_fields: ['comments', 'messages'] },
        ],
      }),
    );

    expect(await readInstagramLoginSubscription('789')).toEqual(['messages', 'comments']);
  });
});
