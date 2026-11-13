import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { answering, invalidBody } from './errors';
import { ErrorBody } from './schemas';

/**
 * How an `/api/v1` route turns a failure into `500 internal`, and a schema's
 * refusal into `invalid_request`, without writing what the request carried
 * into a log line or a developer's message.
 */

describe('answering', () => {
  it('answers 500 internal under the request id, and logs the failure without its query or values', async () => {
    // drizzle's wrapping of a failed query, around Postgres's own error.
    const cause = Object.assign(
      new Error('duplicate key value violates unique constraint "contact_identities_x"'),
      { code: '23505', detail: 'Key (identifier)=(myblu:u_private) already exists.' },
    );
    const failure = new Error(
      'Failed query: insert into "api_sessions" values ($1, $2)\nparams: sbu_hash,201001234567',
      { cause },
    );

    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      const response = await answering('POST /sessions', 'req-1', () => Promise.reject(failure));

      expect(response.status).toBe(500);
      expect(response.headers.get('shipblu-request-id')).toBe('req-1');
      expect(ErrorBody.parse(await response.json()).error).toMatchObject({
        code: 'internal',
        requestId: 'req-1',
      });

      expect(logged).toHaveLength(1);
      const [line, error] = logged[0] as [string, Error];
      expect(line).toBe('[api] failed route=POST /sessions requestId=req-1');
      expect(error.message).toBe(
        'Error 23505: duplicate key value violates unique constraint "contact_identities_x"',
      );
      const printed = `${line}\n${error.message}\n${error.stack}`;
      for (const secret of ['201001234567', 'u_private', 'sbu_hash', 'Failed query']) {
        expect(printed).not.toContain(secret);
      }
      // The frames are kept, so the line still says where it failed.
      expect(error.stack).toMatch(/\n\s+at /);
    } finally {
      spy.mockRestore();
    }
  });

  it('hands back what the work answered', async () => {
    const ok = new Response(null, { status: 204 });
    expect(await answering('DELETE /session', 'req-2', () => Promise.resolve(ok))).toBe(ok);
  });
});

describe('invalidBody', () => {
  const schema = z.object({ phone: z.string().regex(/^\+\d+$/), client: z.object({ v: z.int() }) });

  it('names the first field to blame as the request spelled it, and never repeats its value', async () => {
    const refused = schema.safeParse({ phone: '01001234567', client: { v: 1 } });
    if (refused.success) throw new Error('expected a refusal');
    const body = ErrorBody.parse(await invalidBody('req-3', refused.error).json());
    expect(body.error).toMatchObject({ code: 'invalid_request', field: 'phone' });
    expect(body.error.message).not.toContain('01001234567');

    const nested = schema.safeParse({ phone: '+20', client: { v: 'x' } });
    if (nested.success) throw new Error('expected a refusal');
    expect(ErrorBody.parse(await invalidBody('req-4', nested.error).json()).error.field).toBe(
      'client.v',
    );
  });

  it('names no field when the body itself is the wrong shape', async () => {
    const refused = schema.safeParse(undefined);
    if (refused.success) throw new Error('expected a refusal');
    const body = ErrorBody.parse(await invalidBody('req-5', refused.error).json());
    expect(body.error.field).toBeUndefined();
  });
});
