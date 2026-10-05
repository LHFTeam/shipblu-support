/**
 * Which attachments the console can show as a picture in the conversation.
 *
 * Decided on the stored content type, because that is what Storage serves the
 * object back with. Client-safe on purpose: the timeline is a client component,
 * and `lib/storage`, which has a list of image types of its own for avatars,
 * reads `env()`.
 *
 * Narrower than "anything under image/", and each absence is a reason:
 *
 * - **HEIC and HEIF** are what an iPhone photographs in, and the help-centre
 *   form accepts them (`lib/forms/files.ts`), but only Safari can decode one.
 *   Elsewhere the agent who clicked would get a broken-image box in place of a
 *   link that at least downloads the file.
 * - **TIFF** has the same problem, and nobody photographs a parcel in it.
 * - **SVG** is inert inside an `<img>`, but the preview links to the original,
 *   and opened in a tab an SVG is a document that runs its author's script.
 *   An attachment is written by whoever sent it, and a picture is the one thing
 *   an agent clicks without thinking. Left as a link, opening one stays the
 *   deliberate act it is today.
 *
 * `image/jpg` and `image/pjpeg` are not registered types, but mail clients
 * send both, and the browser decodes the bytes rather than trusting the label.
 */
const PREVIEWABLE = new Set([
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

export function isPreviewableImage(contentType: string): boolean {
  // `image/jpeg; name="IMG_0412.jpg"` is how a MIME part often labels itself.
  return PREVIEWABLE.has(contentType.split(';')[0]!.trim().toLowerCase());
}
