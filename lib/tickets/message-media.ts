/**
 * What the thread needs to know about a message's files beyond their content
 * type: whether its words only stand in for them, and how one should look.
 *
 * Deliberately importing nothing, for the reason `shared-location.ts` gives: it
 * is reached from the timeline, a client component, and a value import from a
 * module that touches `db/client` or `env()` drags the Postgres driver into the
 * browser bundle.
 */

/** The fields of a timeline message these answers read. */
type MediaMessage = {
  bodyText: string;
  bodyHtml: string | null;
  meta: Record<string, unknown> | null;
  attachments: readonly { id: string }[];
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
 * words are then the only sign anything was sent.
 */
export function isMediaStandIn(message: MediaMessage): boolean {
  if (message.bodyHtml !== null || message.attachments.length === 0) return false;
  const text = message.bodyText.trim();
  const meta = message.meta ?? {};
  return text === whatsAppStandIn(meta) || text === metaStandIn(meta, message.attachments.length);
}

/** How a file should look in the thread, where its content type cannot say. */
export type MediaLook = 'sticker' | 'sound';

/**
 * What the sender said each file is, where it matters to how it is drawn.
 *
 * - **A sticker** is a 512px transparent WebP, indistinguishable by its type
 *   from a photo, and drawn at a photo's size it fills the thread.
 * - **Sound** is a Facebook or Instagram voice clip, which arrives as MP4. The
 *   player can tell it has no picture only once it has fetched the file, so
 *   until then it was a black box the size of a video, collapsing to a bar the
 *   moment its metadata arrived. Knowing in advance lets it be drawn as the
 *   voice note it is from the start.
 *
 * Only for a message carrying exactly one file. The sender's list and the
 * stored files cannot otherwise be paired: Meta's are downloaded by one job
 * each, and nothing the thread reads records which entry a file came from.
 */
export function mediaLooks(message: Pick<MediaMessage, 'meta' | 'attachments'>) {
  const looks = new Map<string, MediaLook>();
  const only = message.attachments.length === 1 ? message.attachments[0] : undefined;
  if (!only) return looks;

  const meta = message.meta ?? {};
  const sent = metaAttachmentTypes(meta);
  const kind = meta.whatsappType ?? (sent?.length === 1 ? sent[0] : undefined);
  if (kind === 'sticker') looks.set(only.id, 'sticker');
  if (kind === 'audio') looks.set(only.id, 'sound');
  return looks;
}

/** `displayText` in `lib/whatsapp/parse.ts`, for a media message with no caption. */
function whatsAppStandIn(meta: Record<string, unknown>): string | null {
  const media = isRecord(meta.media) ? meta.media : {};

  switch (meta.whatsappType) {
    case 'image':
    case 'video':
    case 'sticker':
      return `[${meta.whatsappType}]`;
    case 'audio':
      return media.isVoice === true ? '[voice note]' : '[audio]';
    case 'document':
      return typeof media.filename === 'string' && media.filename !== ''
        ? `[document: ${media.filename}]`
        : '[document]';
    default:
      return null;
  }
}

/**
 * The stand-ins `displayText` in `lib/meta/parse.ts` writes that only name the
 * kind of file. Every other type it can write — a share, a story, a story
 * mention, a reel — says where the file came from, and stays.
 */
const META_PLAIN = new Set(['image', 'video', 'audio', 'file', 'sticker']);

/** `displayText` in `lib/meta/parse.ts`, for a direct message with no text. */
function metaStandIn(meta: Record<string, unknown>, files: number): string | null {
  const sent = metaAttachmentTypes(meta);
  if (!sent) return null;

  if (sent.length === 1) {
    const type = sent[0];
    return typeof type === 'string' && META_PLAIN.has(type) ? `[${type}]` : null;
  }
  // A count is only redundant once every file it counts is drawn: one that
  // never downloaded leaves the number as the only sign it was sent.
  return sent.length > 1 && files === sent.length ? `[${sent.length} attachments]` : null;
}

/** The types of a Facebook or Instagram direct message's attachments, in order. */
function metaAttachmentTypes(meta: Record<string, unknown>): unknown[] | null {
  if (meta.metaKind !== 'direct_message' || !Array.isArray(meta.attachments)) return null;
  return meta.attachments.map((attachment: unknown) =>
    isRecord(attachment) ? attachment.type : undefined,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
