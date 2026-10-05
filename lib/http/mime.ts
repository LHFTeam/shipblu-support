/**
 * The media type alone, as the allowlists that read one compare it.
 *
 * `image/jpeg; name="IMG_0412.jpg"` is how a MIME part often labels itself,
 * case is not significant in a type, and a browser's `File.type` is `''` when it
 * has no guess. One copy, because five hand-written ones had already drifted —
 * the form upload path stored its type without lowercasing it — and every
 * allowlist this feeds should agree on what an image is.
 *
 * Client-safe: the help centre's file input reads it too.
 */
export function mimeEssence(value: string | null | undefined): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase();
}
