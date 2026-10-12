/**
 * `Promise.all` over functions rather than promises, with at most `limit` of
 * them running at once, answering in the order they were given.
 *
 * For a page that reads several independent things. `Promise.all` over the
 * reads themselves puts every one on the database pool at the same moment, and
 * a page whose reads outnumber the pool's free places takes all of them from
 * every other request for the length of its render — the Channels page asked
 * for seven at once, plus its layouts' own, against eight (§6.91). A few at a
 * time costs a round trip or two of latency and leaves the rest of the pool to
 * everybody else.
 *
 * The first failure rejects the whole, as `Promise.all` does, and nothing not
 * yet started is started after it.
 */
export async function allLimited<const T extends readonly (() => Promise<unknown>)[]>(
  limit: number,
  tasks: T,
): Promise<{ -readonly [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never }> {
  const results: unknown[] = new Array(tasks.length);
  let next = 0;
  let failed = false;

  const lane = async () => {
    while (!failed && next < tasks.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await tasks[index]!();
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const lanes = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results as { -readonly [K in keyof T]: T[K] extends () => Promise<infer R> ? R : never };
}
