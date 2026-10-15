/**
 * The words ingest writes for a message that has none of its own — a photo, a
 * voice note or a document sent without a caption — so the inbox card, the
 * ticket's subject and search have something to show.
 *
 * Written once, here, because two sides need the same wording: the parsers
 * that store it (`displayText` in `lib/whatsapp/parse.ts` and
 * `lib/meta/parse.ts`) and the thread, which leaves it out where the file it
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
