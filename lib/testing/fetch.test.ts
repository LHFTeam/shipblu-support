import { beforeEach, describe, expect, it } from 'vitest';
import { respondWithGraphError, stubFetch } from './fetch';

const real = globalThis.fetch;

describe('stubFetch', () => {
  it('hands the handler the URL as a string, with the request, and records the call', async () => {
    const mock = stubFetch(async (url, init) => Response.json({ url, method: init?.method }));

    const answer = await fetch(new URL('https://graph.example/v1/me'), { method: 'POST' });

    expect(await answer.json()).toEqual({ url: 'https://graph.example/v1/me', method: 'POST' });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  // Runs after the test above, which stubbed inside the test body.
  it('puts the real fetch back when a test that stubbed it finishes', () => {
    expect(globalThis.fetch).toBe(real);
  });
});

describe('stubFetch in a beforeEach', () => {
  beforeEach(() => {
    stubFetch(() => new Response('stubbed'));
  });

  it('answers the test', async () => {
    expect(await (await fetch('https://anywhere.example')).text()).toBe('stubbed');
  });
});

describe('after a beforeEach stub', () => {
  it('is the real fetch again', () => {
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
