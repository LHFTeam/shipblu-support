import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import {
  TypeSafeApiError,
  choiceAnswer,
  systemOne,
  typesafeConfigured,
  type SystemOneRequest,
} from './client';

/**
 * The transport, and nothing about categorisation.
 *
 * What is worth asserting here is the one thing the queue reads: whether another
 * attempt could plausibly answer differently. Getting that wrong is expensive in
 * both directions — a permanent failure marked transient spends five attempts and
 * an hour of backoff proving a key is still wrong, and a transient one marked
 * permanent throws away a run over a rate limit TypeSafe explicitly asks be
 * retried.
 */

/** A body whose read fails the way a deadline passing mid-read does. */
function stalledBody(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        );
      },
    }),
    { status: 200 },
  );
}

const BASE = 'https://typesafe.test';

const REQUEST: SystemOneRequest = {
  state: { message: 'فين الشحنة' },
  model: 'jev-latest',
  questions: {
    category: {
      type: 'choice',
      instructions: 'Which category?',
      criteria: { 'delivery.where_is_it': 'Where is it', 'meta.unclassified': 'Cannot tell' },
    },
  },
};

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.APP_SECRET = 'x'.repeat(32);
  process.env.TYPESAFE_API_KEY = 'test-key';
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TYPESAFE_API_KEY;
  resetEnvCache();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function answered(body: unknown) {
  return Response.json(body);
}

describe('systemOne', () => {
  it('posts the documented endpoint with a bearer token', async () => {
    const mock = stubFetch(() =>
      answered({
        model: 'jev-1.13.0',
        answers: { category: { type: 'choice', choice: 'delivery.where_is_it' } },
        usage: { input_tokens: 2100, output_tokens: 0 },
      }),
    );

    const response = await systemOne(REQUEST, { baseUrl: BASE });

    expect(String(mock.mock.calls[0]![0])).toBe(`${BASE}/v1/systemone`);
    const init = mock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);

    // The version that answered, not the alias that was asked for.
    expect(response.model).toBe('jev-1.13.0');
    expect(response.inputTokens).toBe(2100);
  });

  it('refuses to call at all without a key, and says which one', async () => {
    delete process.env.TYPESAFE_API_KEY;
    resetEnvCache();
    const mock = stubFetch(() => answered({ answers: {} }));

    await expect(systemOne(REQUEST, { baseUrl: BASE })).rejects.toThrow(/TYPESAFE_API_KEY/);
    expect(mock).not.toHaveBeenCalled();
    expect(typesafeConfigured()).toBe(false);
  });

  it('treats the rate limit and an overload as worth another attempt', async () => {
    // 429 and 529 are the two TypeSafe documents as retryable.
    for (const status of [429, 500, 502, 529]) {
      stubFetch(() => new Response('slow down', { status }));
      await expect(systemOne(REQUEST, { baseUrl: BASE })).rejects.toMatchObject({
        isTransient: true,
        status,
      });
    }
  });

  it('treats a bad key and a bad question as permanent', async () => {
    // Both are us. Retrying either only delays somebody reading the message.
    for (const status of [401, 422]) {
      stubFetch(() => new Response('nope', { status }));
      await expect(systemOne(REQUEST, { baseUrl: BASE })).rejects.toMatchObject({
        isTransient: false,
        status,
      });
    }
  });

  it("carries the provider's own words about a refusal", async () => {
    stubFetch(() => new Response('questions.category.criteria: too many options', { status: 422 }));
    await expect(systemOne(REQUEST, { baseUrl: BASE })).rejects.toThrow(/too many options/);
  });

  it('treats an unreachable provider as transient', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );

    await expect(systemOne(REQUEST, { baseUrl: BASE })).rejects.toMatchObject({
      isTransient: true,
      status: null,
    });
  });

  it('names a deadline that passed before the status, in seconds', async () => {
    stubFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(systemOne(REQUEST, { baseUrl: BASE, timeoutMs: 20_000 })).rejects.toThrow(
      'TypeSafe did not answer in 20s',
    );
  });

  // Mid-body, it had read as "a 200 that was not JSON".
  it('names a deadline that passed mid-body, rather than calling the answer not JSON', async () => {
    stubFetch(() => stalledBody());
    const failure = systemOne(REQUEST, { baseUrl: BASE, timeoutMs: 20_000 });
    await expect(failure).rejects.toThrow("TypeSafe's answer did not finish arriving in 20s");
    await expect(failure).rejects.toMatchObject({ isTransient: true });
  });

  it('treats a 200 that is not JSON as transient', async () => {
    stubFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    await expect(systemOne(REQUEST, { baseUrl: BASE })).rejects.toMatchObject({
      isTransient: true,
    });
  });

  it('treats a 200 missing the answers map as permanent', async () => {
    stubFetch(() => answered({ model: 'jev-1.13.0' }));
    await expect(systemOne(REQUEST, { baseUrl: BASE })).rejects.toMatchObject({
      isTransient: false,
    });
  });

  it('accepts fields it does not read', async () => {
    // Not `.strict()`: TypeSafe adding a field must never fail a run.
    stubFetch(() =>
      answered({
        model: 'jev-1.13.0',
        answers: { category: { type: 'choice', choice: 'meta.unclassified' } },
        usage: { input_tokens: 5, output_tokens: 0, cached_tokens: 3 },
        request_id: 'req_1',
      }),
    );

    await expect(systemOne(REQUEST, { baseUrl: BASE })).resolves.toMatchObject({
      model: 'jev-1.13.0',
    });
  });
});

describe('choiceAnswer', () => {
  const response = {
    model: 'jev-1.13.0',
    inputTokens: 1,
    answers: {
      category: {
        type: 'choice',
        choice: 'delivery.where_is_it',
        probabilities: { 'delivery.where_is_it': 0.88, 'meta.unclassified': 0.12 },
        confidence: 0.81,
      },
      frustration: { type: 'score', score: 1.05 },
    },
  };

  it('reads the named choice, with its distribution', () => {
    expect(choiceAnswer(response, 'category')).toEqual({
      choice: 'delivery.where_is_it',
      probabilities: { 'delivery.where_is_it': 0.88, 'meta.unclassified': 0.12 },
      confidence: 0.81,
    });
  });

  it('records a missing distribution as empty rather than as zero', () => {
    const bare = {
      model: null,
      inputTokens: null,
      answers: { category: { type: 'choice', choice: 'a' } },
    };
    expect(choiceAnswer(bare, 'category')).toEqual({
      choice: 'a',
      probabilities: {},
      confidence: null,
    });
  });

  it('refuses an answer of another primitive', () => {
    // Asking for a score and reading it as a choice is a question built wrongly,
    // which no retry repairs.
    expect(() => choiceAnswer(response, 'frustration')).toThrow(TypeSafeApiError);
    expect(() => choiceAnswer(response, 'frustration')).toThrow(/not a choice/);
  });

  it('refuses a question that was never answered', () => {
    expect(() => choiceAnswer(response, 'missing')).toThrow(/answered nothing/);
  });
});
