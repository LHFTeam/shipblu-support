import { beforeEach, describe, expect, it } from 'vitest';
import { respondWithGraphError, stubFetch } from './fetch';

const real = globalThis.fetch;

// The "real fetch again" tests check what an earlier test left behind, so the
// order is pinned against `--sequence.shuffle`. Under `-t` the earlier test may
// not have run at all; each check then skips rather than passing without
// checking.
describe('the fetch fixture', { shuffle: false }, () => {
  let stubbedInATest = false;
  let stubbedInABeforeEach = false;

  describe('stubFetch', () => {
    it('hands the handler the URL as a string, with the request, and records the call', async () => {
      const mock = stubFetch(async (url, init) => Response.json({ url, method: init?.method }));
      stubbedInATest = true;

      const init = { method: 'POST' };
      const answer = await fetch(new URL('https://graph.example/v1/me'), init);

      expect(await answer.json()).toEqual({ url: 'https://graph.example/v1/me', method: 'POST' });
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0]).toEqual([new URL('https://graph.example/v1/me'), init]);
    });

    it("hands the handler a Request's own URL", async () => {
      const mock = stubFetch(async (url) => new Response(url));

      const answer = await fetch(new Request('https://graph.example/v1/me/messages'));

      expect(await answer.text()).toBe('https://graph.example/v1/me/messages');
      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('puts the real fetch back when a test that stubbed it finishes', (ctx) => {
      if (!stubbedInATest) ctx.skip();
      expect(globalThis.fetch).toBe(real);
    });
  });

  describe('stubFetch in a beforeEach', () => {
    beforeEach(() => {
      stubFetch(() => new Response('stubbed'));
    });

    it('answers the test', async () => {
      expect(await (await fetch('https://anywhere.example')).text()).toBe('stubbed');
      stubbedInABeforeEach = true;
    });
  });

  describe('after a beforeEach stub', () => {
    it('is the real fetch again', (ctx) => {
      if (!stubbedInABeforeEach) ctx.skip();
      expect(globalThis.fetch).toBe(real);
    });
  });

  describe('respondWithGraphError', () => {
    it("answers with Graph's error body, the status, and the code when there is one", async () => {
      respondWithGraphError(400, 190, 'Error validating access token');
      const coded = await fetch('https://graph.example');
      expect(coded.status).toBe(400);
      expect(await coded.json()).toEqual({
        error: { message: 'Error validating access token', code: 190 },
      });

      respondWithGraphError(503, null);
      expect(await (await fetch('https://graph.example')).json()).toEqual({
        error: { message: 'nope' },
      });
    });
  });
});
