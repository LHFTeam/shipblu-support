import { mimeEssence } from '@/lib/http/mime';

/**
 * What the chat widget will carry as an attachment, and how it says no.
 *
 * Client-safe, and judged on both sides of the wire by the same functions, as
 * `parseVisitorDetails` is: the composer refuses a file before anything
 * uploads, and `/api/widget/message` refuses it again with the same answer, so
 * a check that passes in the panel and fails on the server — leaving the
 * visitor looking at a send that did nothing — cannot happen by drift. The
 * server then reads the bytes (`./sniff.ts`), because what is decided here is
 * only what the browser *says* a file is.
 *
 * The four kinds are what a customer writing about a parcel actually sends: a
 * photograph of the box, a PDF of the invoice or the waybill, a video of the
 * courier at the door, and a voice recording because typing it out was harder.
 * An allowlist, for the reason `lib/forms/files.ts` gives, and narrower than
 * that one: no office documents and no spreadsheets, which nobody asked a chat
 * to carry, and no SVG, which is a document that runs its author's script.
 */

export type WidgetFileKind = 'image' | 'video' | 'audio' | 'document';

/**
 * The longest message the composer takes and the route stores, in UTF-16 code
 * units as `maxLength` counts them. One number for both, or one side raised
 * without the other lets a visitor type an ending the route then cuts off.
 */
export const MAX_WIDGET_MESSAGE_CHARS = 5000;

/** Enough for a handful of photos of one parcel in one message. */
export const MAX_WIDGET_FILES = 5;

/**
 * One file, and every file of a message together.
 *
 * The same number for both, so the panel has one size to state. It is bounded
 * from above by `proxyClientMaxBodySize` in `next.config.ts` (27 MB): `proxy.ts`
 * runs on every route, so Next clones each request body first, and a clone over
 * that cap is truncated rather than refused, which arrives here as a corrupt
 * multipart body with nothing the visitor could act on. Twenty-five leaves room
 * for the text and the multipart framing; `MAX_WIDGET_REQUEST_BYTES` is that
 * room, checked against `Content-Length` before the body is read.
 *
 * A phone's video runs past it within a minute or so. That is the limit
 * working: the bytes are buffered in memory before anything here runs, so this
 * is also how much RAM a single request may ask an instance for.
 */
export const MAX_WIDGET_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_WIDGET_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_WIDGET_REQUEST_BYTES = MAX_WIDGET_TOTAL_BYTES + 1024 * 1024;

/**
 * Types by what the browser labels them, and the extension each falls back to.
 *
 * A Map for the reason `lib/attachments/preview.ts` gives: the key is a
 * sender's string, and `'__proto__'` read off an object literal answers.
 *
 * The audio half is long because a "voice recording" is whatever the phone's
 * recorder wrote: `m4a` from an iPhone's Voice Memos and most Android
 * recorders, `ogg`/`opus` from a WhatsApp export, `amr` and `3gp` from older
 * Android ones, `webm` from a browser, `mp3`, `aac` and `wav` from everything
 * else. Several of these come labelled two ways depending on the browser.
 */
const BY_TYPE = new Map<string, WidgetFileKind>([
  ['image/jpeg', 'image'],
  ['image/jpg', 'image'],
  ['image/pjpeg', 'image'],
  ['image/png', 'image'],
  ['image/gif', 'image'],
  ['image/webp', 'image'],
  ['image/heic', 'image'],
  ['image/heif', 'image'],
  ['image/heic-sequence', 'image'],
  ['image/heif-sequence', 'image'],
  ['image/avif', 'image'],

  ['application/pdf', 'document'],

  ['video/mp4', 'video'],
  ['video/quicktime', 'video'],
  ['video/webm', 'video'],
  ['video/3gpp', 'video'],
  ['video/3gpp2', 'video'],
  ['video/x-m4v', 'video'],

  ['audio/mpeg', 'audio'],
  ['audio/mp3', 'audio'],
  ['audio/mp4', 'audio'],
  ['audio/x-m4a', 'audio'],
  ['audio/m4a', 'audio'],
  ['audio/aac', 'audio'],
  ['audio/x-aac', 'audio'],
  ['audio/aacp', 'audio'],
  // What Windows' registry calls `.aac`, which Chrome, Edge and Firefox read
  // there since none of them has an `aac` entry of its own.
  ['audio/vnd.dlna.adts', 'audio'],
  ['audio/aac-adts', 'audio'],
  ['audio/ogg', 'audio'],
  // Firefox's own table labels every `.ogg` this way, before it asks the
  // system, so without it no Ogg voice note could be attached from Firefox.
  ['application/ogg', 'audio'],
  ['audio/opus', 'audio'],
  ['audio/wav', 'audio'],
  ['audio/x-wav', 'audio'],
  ['audio/wave', 'audio'],
  ['audio/vnd.wave', 'audio'],
  ['audio/webm', 'audio'],
  ['audio/amr', 'audio'],
  ['audio/3gpp', 'audio'],
  ['audio/3gpp2', 'audio'],
]);

/**
 * For a file the browser gave no type, or only `application/octet-stream`:
 * Chrome on Windows has no type for `.heic`, and several browsers none for
 * `.amr` or `.opus`. `webm` and `3gp` are read as video, their usual content,
 * which is only what is admitted: what is stored is the server's reading
 * (`sniffWidgetFile`), which finds a WebM's tracks and stores one with sound
 * alone as audio.
 */
const BY_EXTENSION = new Map<string, WidgetFileKind>([
  ['jpg', 'image'],
  ['jpeg', 'image'],
  ['png', 'image'],
  ['gif', 'image'],
  ['webp', 'image'],
  ['heic', 'image'],
  ['heif', 'image'],
  ['avif', 'image'],
  ['pdf', 'document'],
  ['mp4', 'video'],
  ['m4v', 'video'],
  ['mov', 'video'],
  ['webm', 'video'],
  ['3gp', 'video'],
  ['3g2', 'video'],
  ['mp3', 'audio'],
  ['m4a', 'audio'],
  ['aac', 'audio'],
  ['ogg', 'audio'],
  ['oga', 'audio'],
  ['opus', 'audio'],
  ['wav', 'audio'],
  ['amr', 'audio'],
]);

/**
 * The file picker's `accept`, so the picker filters before anything uploads.
 *
 * Families rather than the list above, because on a phone the family is what
 * offers the camera and the recorder beside the file browser; the extensions
 * are for the types a desktop browser cannot map to a family. What the families
 * let through that the list does not is refused by `declaredKind` with a
 * sentence, rather than hidden.
 */
export const WIDGET_ACCEPT = [
  'image/*',
  'video/*',
  'audio/*',
  'application/pdf',
  ...[...BY_EXTENSION.keys()].map((extension) => `.${extension}`),
].join(',');

/** The part of a `File` these checks read, so the server's parts and the tests pass too. */
export type FileLike = { name: string; size: number; type: string };

function extensionOf(name: string): string {
  return /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
}

/**
 * What the browser says a file is, or null for a file the widget does not
 * carry. The browser's label wins over the name when it has one; the name is
 * read only when it has none, so `photo.jpg` labelled `text/html` is refused
 * rather than believed.
 */
export function declaredKind(file: Pick<FileLike, 'name' | 'type'>): WidgetFileKind | null {
  const type = mimeEssence(file.type);
  if (type && type !== 'application/octet-stream') return BY_TYPE.get(type) ?? null;
  return BY_EXTENSION.get(extensionOf(file.name)) ?? null;
}

export type WidgetFileRefusal =
  | { reason: 'too_many' }
  | { reason: 'too_large'; filename: string }
  | { reason: 'too_large_total' }
  | { reason: 'type'; filename: string }
  | { reason: 'empty'; filename: string };

/**
 * Adds files to the ones already chosen, one at a time, keeping every one that
 * fits and naming the first that does not.
 *
 * One at a time rather than all or nothing, because the picker hands over a
 * whole selection: three photos with one 40 MB video among them should leave
 * the three photos chosen and say why the video is not, not drop all four.
 */
export function admitWidgetFiles<T extends FileLike>(
  current: readonly T[],
  incoming: readonly T[],
): { admitted: T[]; refusal: WidgetFileRefusal | null } {
  const admitted = [...current];
  let total = admitted.reduce((sum, file) => sum + file.size, 0);
  let refusal: WidgetFileRefusal | null = null;

  for (const file of incoming) {
    const refused = refusalFor(file, admitted.length, total);
    if (refused) {
      refusal ??= refused;
      continue;
    }
    admitted.push(file);
    total += file.size;
  }

  return { admitted, refusal };
}

/** The same judgement over a message's files as a whole, which is the server's question. */
export function checkWidgetFiles(files: readonly FileLike[]): WidgetFileRefusal | null {
  return admitWidgetFiles([], files).refusal;
}

function refusalFor(file: FileLike, count: number, total: number): WidgetFileRefusal | null {
  if (!declaredKind(file)) return { reason: 'type', filename: file.name };
  // A recording that saved nothing, or a cloud file not yet on the phone: said
  // in the panel, where sending it would have stored the words without it.
  if (file.size === 0) return { reason: 'empty', filename: file.name };
  if (file.size > MAX_WIDGET_FILE_BYTES) return { reason: 'too_large', filename: file.name };
  if (count >= MAX_WIDGET_FILES) return { reason: 'too_many' };
  if (total + file.size > MAX_WIDGET_TOTAL_BYTES) return { reason: 'too_large_total' };
  return null;
}

/**
 * The name a file is stored and shown under.
 *
 * Display only — the stored key is derived from ids (`buildAttachmentPath`) —
 * but it is shown to an agent, in the ticket's thread and in the stand-in
 * `[document: …]` its message's text becomes, so the characters that could make
 * it lie are removed: control characters, C1 included; the line and paragraph
 * separators, which put a break inside the ticket's subject; the byte-order
 * mark; and the bidirectional marks and overrides — Arabic's own among them — that
 * draw `invoice<U+202E>fdp.exe` as `invoiceexe.pdf`. An Arabic name keeps its letters;
 * only the invisible formatting goes. Capped at the column's width.
 */
export function cleanFilename(name: string, fallbackExtension: string): string {
  const cleaned = name.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g,
    '',
  );
  const trimmed = cleaned.trim().slice(0, 255);
  return trimmed || `file.${fallbackExtension}`;
}
