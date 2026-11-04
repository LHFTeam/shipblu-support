import type { VisitorUpload } from './conversation';
import { checkWidgetFiles, cleanFilename, type WidgetFileRefusal } from './files';
import { sniffWidgetFile } from './sniff';

/**
 * The files a widget message arrived with, judged and read for storing.
 *
 * Judged first by the composer's own rules (`checkWidgetFiles`), so a file the
 * panel would have refused is refused here with the same reason; then read, and
 * each one's type taken from its bytes (`sniffWidgetFile`), which is the only
 * reading stored. A file whose bytes are none of the widget's types is refused
 * as `type`, under the name the visitor knows it by.
 *
 * Nothing is stored here. The bytes are held for `appendVisitorMessage`, which
 * stores them with the message or not at all.
 */
export async function readVisitorUploads(
  files: readonly File[],
): Promise<{ ok: true; uploads: VisitorUpload[] } | { ok: false; refusal: WidgetFileRefusal }> {
  const refusal = checkWidgetFiles(files);
  if (refusal) return { ok: false, refusal };

  const uploads: VisitorUpload[] = [];
  for (const file of files) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const sniffed = sniffWidgetFile(bytes, file.type);
    if (!sniffed) return { ok: false, refusal: { reason: 'type', filename: file.name } };

    uploads.push({
      filename: cleanFilename(file.name, sniffed.extension),
      contentType: sniffed.contentType,
      kind: sniffed.kind,
      extension: sniffed.extension,
      bytes,
    });
  }
  return { ok: true, uploads };
}

/** A megabyte, the unit the upload budgets in `/api/widget/message` are counted in. */
export function megabytesOf(uploads: readonly VisitorUpload[]): number {
  const bytes = uploads.reduce((sum, upload) => sum + upload.bytes.length, 0);
  return Math.max(1, Math.ceil(bytes / (1024 * 1024)));
}
