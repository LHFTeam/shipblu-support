import type { z } from 'zod';

/**
 * A request's JSON body when it parses and has the shape `schema` describes,
 * and null when it does not.
 *
 * The public routes each read their body as `(await request.json()) as typeof
 * body` inside a `try`, then read fields off the result. The `try` refuses text
 * that is not JSON; the cast only asserts the rest. `null` is valid JSON, so it
 * passed the `try` and threw at the first field read — six anonymous endpoints
 * answered it with a 500. A schema checks what the cast took on trust.
 *
 * Null for both failures rather than an error saying which, because no caller
 * answers them differently, and the answer is the route's to spell: the widget
 * parses those bodies, so each route keeps its own.
 */
export async function readJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return null;
  }

  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
