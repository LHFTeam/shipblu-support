/**
 * What a form will accept as an attachment, and how it says no.
 *
 * Split from `./attachments.ts` by which side of the wire runs it, the same way
 * `lib/tickets/custom-fields.ts` is split from its parser: the file input on the
 * help centre needs the `accept` list and the count, and the module that stores
 * a file needs the database and the storage client. One file for both puts
 * `node:fs` in the browser bundle, which is a build error rather than a subtle
 * one — but only because Next happens to check.
 *
 * Files arrive as `File` entries in the server action's own multipart body, and
 * there is deliberately **no upload endpoint**. On a form that does not require
 * signing in, an endpoint that accepts bytes before a ticket exists is an
 * unauthenticated write to our storage bucket — a free file host — and it would
 * need its own session, its own rate limit and its own sweep for the objects
 * whose form was never submitted. Riding along with the submission means a file
 * cannot exist without the ticket that explains it.
 */

/** Enough for a few photos of a damaged parcel; not enough to be a backup target. */
export const MAX_FORM_FILES = 5;
export const MAX_FORM_FILE_BYTES = 10 * 1024 * 1024;

/**
 * And a ceiling on the submission as a whole.
 *
 * Five files at the per-file limit is 50 MB, and a server action's body is
 * buffered in memory before any of this runs — so the real limit is
 * `serverActions.bodySizeLimit` in `next.config.ts`, which is set just above
 * this number. The check here exists so a customer who goes over sees a sentence
 * naming the problem instead of Next's own rejection, which says only that the
 * request failed.
 */
export const MAX_FORM_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * What a support ticket actually arrives with: photographs of a parcel, a PDF
 * invoice, a spreadsheet of order numbers.
 *
 * An allowlist rather than a denylist of executables. The bucket is private and
 * nothing here is ever served as HTML, so the risk is not the browser — it is
 * that a general-purpose upload becomes storage somebody else is paying for.
 * A type nobody has asked for is a type an admin can ask for.
 */
const ACCEPTED = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** The `accept` attribute, so the file picker filters before anything uploads. */
export const ACCEPT_ATTRIBUTE = [...ACCEPTED].join(',');

export type FileRefusal =
  | { reason: 'too_many' }
  | { reason: 'too_large'; filename: string }
  | { reason: 'too_large_total' }
  | { reason: 'type'; filename: string };

export type CheckedFiles = { ok: true; files: File[] } | { ok: false; refusal: FileRefusal };

/**
 * Checked before the ticket is created, not after.
 *
 * A submission refused for a 40 MB photo should come back as a form error with
 * the answers still in the boxes. Creating the ticket first and discovering the
 * file afterwards leaves the customer looking at a confirmation page for a
 * ticket that is missing the evidence it is about.
 */
export function checkFormFiles(entries: unknown[]): CheckedFiles {
  const files = entries.filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (files.length > MAX_FORM_FILES) return { ok: false, refusal: { reason: 'too_many' } };

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_FORM_TOTAL_BYTES) {
    return { ok: false, refusal: { reason: 'too_large_total' } };
  }

  for (const file of files) {
    if (file.size > MAX_FORM_FILE_BYTES) {
      return { ok: false, refusal: { reason: 'too_large', filename: file.name } };
    }
    // The browser's guess, and it is the only one available before the bytes are
    // read. It is a courtesy check: the allowlist bounds what an honest customer
    // uploads, and the private bucket is what bounds what a dishonest one gains.
    const type = (file.type || '').split(';')[0]!.trim().toLowerCase();
    if (!ACCEPTED.has(type)) {
      return { ok: false, refusal: { reason: 'type', filename: file.name } };
    }
  }

  return { ok: true, files };
}
