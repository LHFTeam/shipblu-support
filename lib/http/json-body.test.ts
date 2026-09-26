import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readJsonBody } from './json-body';

const shape = z.object({ token: z.string() });

function request(body: string): Request {
  return new Request('https://support.example/api', { method: 'POST', body });
}

describe('readJsonBody', () => {
  it('returns the body when it parses and has the shape', async () => {
    expect(await readJsonBody(request('{"token":"t"}'), shape)).toEqual({ token: 't' });
  });

  it('returns null for text that is not JSON', async () => {
    expect(await readJsonBody(request('{not json'), shape)).toBeNull();
  });

  it('returns null for an empty body', async () => {
    expect(await readJsonBody(request(''), shape)).toBeNull();
  });

  it.each(['null', '5', '"text"', '[]', 'true'])(
    'returns null for JSON that is not an object: %s',
    async (body) => {
      expect(await readJsonBody(request(body), shape)).toBeNull();
    },
  );

  it('returns null for an object of the wrong shape', async () => {
    expect(await readJsonBody(request('{"token":5}'), shape)).toBeNull();
  });
});
