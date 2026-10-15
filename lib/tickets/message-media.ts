/**
 * What the thread needs to know about a message's files beyond their content
 * type: whether its words only stand in for them, and how one should look.
 *
 * Importing only what is client-safe, for the reason `shared-location.ts`
 * gives: it is reached from the timeline, a client component, and a value
 * import from a module that touches `db/client` or `env()` drags the Postgres
 * driver into the browser bundle.
 */

import { mediaFamily } from '@/lib/attachments/preview';
import { metaAttachmentsStandIn, whatsAppMediaStandIn } from '@/lib/chat/stand-ins';
import { isRecord } from '@/lib/whatsapp/parse';

/** The fields of a timeline message these answers read. */
type MediaMessage = {
  bodyText: string;
  bodyHtml: string | null;
  meta: Record<string, unknown> | null;
  attachments: readonly { id: string; contentType: string }[];
};

/**
 * Whether a message's text is only the stand-in ingest wrote for the files it
 * carries, so the thread can draw the files alone.
 *
 * A photo, a voice note or a document sent without a caption reaches us with no
 * text, and ingest writes one for it — `[image]`, `[voice note]`,
 * `[document: awb.pdf]`, `[2 attachments]` — because the inbox card, the
 * ticket's subject and search need something to show (`displayText` in
 * `lib/whatsapp/parse.ts` and `lib/meta/parse.ts`). In the thread the file
 * itself is drawn right below, so the stand-in was a line saying what the next
 * line showed. Only the thread leaves it out: the stored text stays, because
 * every other reader depends on it.
 *
 * Rebuilt from this row's own stored type, voice flag and filename, and
 * compared exactly, rather than matched as "anything in brackets". The loose
 * form would also hide words that carry something the file does not:
 * `[story_mention]` is the only sign the photo is the customer's story naming
 * us, `[unsupported message type]` explains the message, and a caption reading
 * `[urgent] where is my COD` is the customer's own. A support tool dropping a
 * customer's sentence is a worse failure than a redundant line, so anything the
 * rebuild does not produce is kept.
 *
 * Never when no file is drawn in its place: a download still running, one that
 * failed, and a copied chat's `[media]`, whose file the copy does not carry. The
 * words are then the only sign anything was sent. Nor when the file is drawn
 * without what the words say: a document's name (see `whatsAppStandIn`).
 */
export function isMediaStandIn(message: MediaMessage): boolean {
  if (message.bodyHtml !== null || message.attachments.length === 0) return false;
  const text = message.bodyText.trim();
  const meta = message.meta ?? {};
  return (
    text === whatsAppStandIn(meta, message.attachments) ||
    text === metaStandIn(meta, message.attachments.length)
  );
}

/** How a file should look in the thread, where its content type cannot say. */
export type MediaLook = 'sticker' | 'sound';

/**
 * What the sender said each file is, where it matters to how it is drawn.
 *
 * - **A sticker** is a 512px transparent WebP, indistinguishable by its type
 *   from a photo, and drawn at a photo's size it fills the thread. Messenger's
 *   arrive as `image` and are known by the flag the parser keeps for them.
 * - **Sound** is a Facebook or Instagram voice clip, which arrives as MP4. The
 *   player can tell it has no picture only once it has fetched the file, so
 *   until then it was a black box the size of a video, collapsing to a bar the
 *   moment its metadata arrived. Knowing in advance lets it be drawn as the
 *   voice note it is from the start. A WhatsApp voice note is marked too, which
 *   changes nothing: its type already says it is audio.
 *
 * Only for a message carrying exactly one file. Meta's files are downloaded by
 * one job each, and the entry each came from is stored (`content_id` is
 * `meta:<index>`, `download_media`) but not sent to the browser, so with
 * several files the thread cannot pair them.
 */
export function mediaLooks(message: Pick<MediaMessage, 'meta' | 'attachments'>) {
  const looks = new Map<string, MediaLook>();
  const only = message.attachments.length === 1 ? message.attachments[0] : undefined;
  if (!only) return looks;

  const meta = message.meta ?? {};
  const sent = metaAttachments(meta);
  const entry = sent?.length === 1 ? sent[0] : undefined;
  const kind = meta.whatsappType ?? entry?.type;
  if (kind === 'sticker' || entry?.sticker === true) looks.set(only.id, 'sticker');
  else if (kind === 'audio') looks.set(only.id, 'sound');
  return looks;
}

/**
 * The index Meta's download job files an attachment under (`content_id`
 * `meta:<index>`, `download_media`), which is the order its sender put it in;
 * null for any other file.
 */
export function metaIndex(contentId: string | null): number | null {
  const match = /^meta:(\d+)$/.exec(contentId ?? '');
  return match ? Number(match[1]) : null;
}

const WHATSAPP_MEDIA = ['image', 'video', 'audio', 'document', 'sticker'] as const;

/** What `displayText` in `lib/whatsapp/parse.ts` wrote for this row, had it no caption. */
function whatsAppStandIn(
  meta: Record<string, unknown>,
  files: MediaMessage['attachments'],
): string | null {
  const type = WHATSAPP_MEDIA.find((media) => media === meta.whatsappType);
  if (!type) return null;
  const media = isRecord(meta.media) ? meta.media : {};
  const filename = typeof media.filename === 'string' ? media.filename : null;

  // A document's words carry the name its sender gave it — a photographed
  // label saved under its waybill number, say — and only a link shows that
  // name again. One that is a picture or a recording is drawn as one, under no
  // name at all, so there the words are the only place the name is.
  if (type === 'document' && filename && files.some((file) => mediaFamily(file.contentType))) {
    return null;
  }
  return whatsAppMediaStandIn(type, { filename, voice: media.isVoice === true });
}

/**
 * The types whose stand-in only names the kind of file drawn below it. Every
 * other type Meta can send — a share, a story, a story mention, a reel — says
 * where the file came from, and a `file` is linked under a name its download
 * job made up, so `[file]` is the only word saying what it is: those stay.
 */
const META_PLAIN = new Set(['image', 'video', 'audio', 'sticker']);

/** What `displayText` in `lib/meta/parse.ts` wrote for this row, had it no text. */
function metaStandIn(meta: Record<string, unknown>, files: number): string | null {
  const sent = metaAttachments(meta);
  if (!sent) return null;
  const types = sent.map((entry) => (typeof entry.type === 'string' ? entry.type : undefined));

  if (sent.length === 1 && !META_PLAIN.has(types[0] ?? '')) return null;
  // A count is only redundant once every file it counts is drawn: one that
  // never downloaded leaves the number as the only sign it was sent.
  if (sent.length > 1 && files !== sent.length) return null;
  return metaAttachmentsStandIn(types) || null;
}

/** A Facebook or Instagram direct message's attachments as stored, in order. */
function metaAttachments(meta: Record<string, unknown>): Record<string, unknown>[] | null {
  if (meta.metaKind !== 'direct_message' || !Array.isArray(meta.attachments)) return null;
  return meta.attachments.map((entry: unknown) => (isRecord(entry) ? entry : {}));
}
