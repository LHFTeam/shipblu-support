/**
 * A response body read whole, refused as soon as it passes `maxBytes`.
 *
 * Enforced **while reading**, not after. Checking the length of a Buffer that
 * has already been materialised is not a guard against anything: the memory it
 * exists to bound has been allocated by the time the check runs, so a wrong or
 * hostile URL would cost the worker the whole body first and report "too
 * large" afterwards. So a declared `Content-Length` over the cap is refused up
 * front, and a body with none is cancelled mid-read once it passes the cap.
 *
 * `tooLarge` builds the error, so each caller refuses in its own vocabulary:
 * Meta's media download throws `MetaContentTooLargeError`, which its callers
 * read as "finished, do not retry", and the knowledge base's image copy throws
 * the error its job names a picture by. One copy of the reading, where there
 * were two that had already drifted.
 *
 * The caller owns the deadline: the signal it gave `fetch` governs the body
 * read here too, and a deadline passing mid-body rejects with that signal's
 * reason, which the caller turns into a sentence.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }

  const reader = response.body?.getReader();
  // No body to stream: an empty response, or a runtime that did not give us
  // one. `arrayBuffer` is bounded by the header check above in that case.
  if (!reader) {
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > maxBytes) throw tooLarge();
    return content;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
