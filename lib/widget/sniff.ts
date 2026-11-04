import { mimeEssence } from '@/lib/http/mime';
import type { WidgetFileKind } from './files';

/**
 * What a file the widget was sent actually is, read from its first bytes.
 *
 * `declaredKind` in `./files.ts` judges what the browser *says*, which is all
 * the panel has before it uploads. The server has the bytes, and it is the
 * server's answer that is stored as `attachments.content_type` — which is what
 * Storage serves the object back with, and what the console's thread decides on
 * when it draws a chat's file without a click (`drawsMediaInline`). So a label
 * is never stored verbatim: `photo.jpg` sent as `image/jpeg` that is really an
 * HTML page has no signature here and is refused, and a voice memo the browser
 * labelled `audio/x-m4a` is stored as `audio/mp4`, the one spelling the
 * console's player list reads (`lib/attachments/preview.ts`).
 *
 * The browser's label is read only where the bytes cannot settle it: an MP4,
 * WebM or 3GP container holds sound alone as readily as a picture, and nothing
 * in its first bytes says which, so a container labelled `audio/*` is stored as
 * audio and anything else in it as video.
 *
 * Pure, and importing only a type and the shared MIME reader: the tests feed it
 * byte arrays.
 */

export type SniffedFile = {
  /** What is stored and served, from the widget's own list — never the browser's string. */
  contentType: string;
  kind: WidgetFileKind;
  /** For the stored key, which is derived from ids and this, never from the file's name. */
  extension: string;
};

/** Enough for every signature below, the PDF header's allowance aside. */
const HEAD = 64;

export function sniffWidgetFile(bytes: Uint8Array, declaredType: string): SniffedFile | null {
  if (bytes.length < 12) return null;
  const declaredAudio = mimeEssence(declaredType).startsWith('audio/');

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return image('image/jpeg', 'jpg');
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return image('image/png', 'png');
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    return image('image/gif', 'gif');
  }
  if (ascii(bytes, 0, 4) === 'RIFF') {
    const form = ascii(bytes, 8, 12);
    if (form === 'WEBP') return image('image/webp', 'webp');
    if (form === 'WAVE') return audio('audio/wav', 'wav');
    return null;
  }

  // The header may sit anywhere in the first kilobyte, which readers accept
  // and some generators use.
  if (indexOfAscii(bytes, '%PDF-', 1024) !== -1) {
    return { contentType: 'application/pdf', kind: 'document', extension: 'pdf' };
  }

  if (ascii(bytes, 4, 8) === 'ftyp') return isoMedia(bytes, declaredAudio);

  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML, which is WebM or Matroska. Only WebM is a type a browser is asked
    // to play by that name, and its DocType says so within the first bytes.
    if (indexOfAscii(bytes, 'webm', HEAD) === -1) return null;
    return declaredAudio ? audio('audio/webm', 'webm') : video('video/webm', 'webm');
  }

  if (ascii(bytes, 0, 4) === 'OggS') return audio('audio/ogg', 'ogg');
  if (ascii(bytes, 0, 5) === '#!AMR') return audio('audio/amr', 'amr');
  if (ascii(bytes, 0, 3) === 'ID3') return audio('audio/mpeg', 'mp3');

  if (bytes[0] === 0xff) {
    const second = bytes[1]!;
    // ADTS, the raw AAC a recorder writes as `.aac`: twelve sync bits and a
    // layer of zero.
    if ((second & 0xf6) === 0xf0) return audio('audio/aac', 'aac');
    // An MPEG audio frame with no ID3 tag in front: eleven sync bits and any
    // layer but the reserved one.
    if ((second & 0xe0) === 0xe0 && ((second >> 1) & 0x03) !== 0) {
      return audio('audio/mpeg', 'mp3');
    }
  }

  return null;
}

/**
 * An ISO base media file — MP4, QuickTime, 3GP, M4A, HEIF, AVIF — told apart by
 * the brands in its `ftyp` box: the major brand first, then the compatible
 * ones the box lists after it.
 */
function isoMedia(bytes: Uint8Array, declaredAudio: boolean): SniffedFile | null {
  const boxSize = readUint32(bytes, 0);
  const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : 16, 256);
  const brands = [ascii(bytes, 8, 12)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(bytes, at, at + 4));
  const has = (names: readonly string[]) => brands.some((brand) => names.includes(brand));
  const major = brands[0]!;

  // A picture by its major brand only, so a video whose compatible list
  // happens to name an image brand is still read as the video it is. The
  // generic HEIF brands are the exception, since an iPhone photo can carry
  // `mif1` first and `heic` after it.
  if (AVIF_BRANDS.includes(major)) return image('image/avif', 'avif');
  if (HEIC_BRANDS.includes(major)) return image('image/heic', 'heic');
  if (major === 'mif1' || major === 'msf1') {
    if (has(HEIC_BRANDS)) return image('image/heic', 'heic');
    if (has(AVIF_BRANDS)) return image('image/avif', 'avif');
    return image('image/heif', 'heif');
  }

  if (major === 'M4A ' || major === 'M4B ' || major === 'F4A ') return audio('audio/mp4', 'm4a');
  if (major.startsWith('3g')) {
    return declaredAudio ? audio('audio/3gpp', '3gp') : video('video/3gpp', '3gp');
  }
  if (major === 'qt  ')
    return declaredAudio ? audio('audio/mp4', 'm4a') : video('video/quicktime', 'mov');
  return declaredAudio ? audio('audio/mp4', 'm4a') : video('video/mp4', 'mp4');
}

const AVIF_BRANDS = ['avif', 'avis'];
const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs'];

const image = (contentType: string, extension: string): SniffedFile => ({
  contentType,
  kind: 'image',
  extension,
});
const audio = (contentType: string, extension: string): SniffedFile => ({
  contentType,
  kind: 'audio',
  extension,
});
const video = (contentType: string, extension: string): SniffedFile => ({
  contentType,
  kind: 'video',
  extension,
});

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let text = '';
  for (let index = start; index < end && index < bytes.length; index++) {
    text += String.fromCharCode(bytes[index]!);
  }
  return text;
}

function indexOfAscii(bytes: Uint8Array, needle: string, within: number): number {
  const limit = Math.min(bytes.length, within) - needle.length;
  outer: for (let at = 0; at <= limit; at++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (bytes[at + offset] !== needle.charCodeAt(offset)) continue outer;
    }
    return at;
  }
  return -1;
}

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!
  );
}
