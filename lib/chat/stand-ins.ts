/**
 * The words ingest writes for a message that has none of its own — a photo, a
 * voice note or a document sent without a caption — so the inbox card, the
 * ticket's subject and search have something to show.
 *
 * Written once, here, because two sides need the same wording: the code that
 * stores it (`displayText` in `lib/whatsapp/parse.ts` and `lib/meta/parse.ts`,
 * and the widget's `appendVisitorMessage`) and the thread, which leaves it out where the file it
 * stands in for is drawn instead (`isMediaStandIn`). The thread rebuilds it from
 * what the row stored and compares, so wording changed anywhere but here would
 * quietly put the stand-in back above the file.
 *
 * Importing nothing: the timeline, a client component, reaches it.
 */

/** A WhatsApp media message's: `[image]`, `[voice note]`, `[document: awb.pdf]`. */
export function whatsAppMediaStandIn(
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker',
  media: { filename?: string | null; voice?: boolean },
): string {
  if (type === 'document' && media.filename) return `[document: ${media.filename}]`;
  if (type === 'audio' && media.voice) return '[voice note]';
  return `[${type}]`;
}

/**
 * A Facebook or Instagram direct message's, from the types its attachments
 * arrived as: `[image]` for one, `[3 attachments]` for several, and nothing for
 * none.
 */
export function metaAttachmentsStandIn(types: readonly (string | undefined)[]): string {
  if (types.length === 1) return `[${types[0] ?? 'attachment'}]`;
  if (types.length > 1) return `[${types.length} attachments]`;
  return '';
}

/**
 * A web chat message's, from the files the visitor attached in the widget:
 * `[image]`, `[video]`, `[audio]` and `[document: invoice.pdf]` for one, as
 * WhatsApp's read, and `[2 attachments]` for several, as Meta's do. The name
 * goes in for a document because a PDF's name is often the only thing saying
 * which invoice or waybill it is, and the inbox card and search read only the
 * text. Nothing for no files, so the caller keeps whatever the visitor typed.
 */
export function webchatFilesStandIn(
  files: readonly { kind: 'image' | 'video' | 'audio' | 'document'; filename?: string | null }[],
): string {
  const [only] = files;
  if (files.length === 1 && only) {
    return only.kind === 'document' && only.filename
      ? `[document: ${only.filename}]`
      : `[${only.kind}]`;
  }
  if (files.length > 1) return `[${files.length} attachments]`;
  return '';
}
