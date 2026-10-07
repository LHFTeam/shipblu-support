/**
 * The media type alone, as the allowlists that read one compare it.
 *
 * `image/jpeg; name="IMG_0412.jpg"` is how a MIME part often labels itself,
 * case is not significant in a type, and a browser's `File.type` is `''` when it
 * has no guess. One copy, because the seven hand-written ones had already
 * drifted on whether case counts, and every allowlist this feeds should agree on
 * what an image is.
 *
 * The stored `attachments.content_type` is not always an essence: the Facebook
 * and Instagram download keeps the header as the CDN sent it, parameters and
 * all. So code that reads the column takes the essence itself rather than
 * comparing it verbatim.
 *
 * Client-safe: the inbox's attachment list reads it in the browser.
 */
export function mimeEssence(value: string | null | undefined): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase();
}
