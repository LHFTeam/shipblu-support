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
 * What the browser said is read only where the bytes cannot settle it, and
 * then as the kind the file was admitted as (`declaredKind`), so the two halves
 * agree on a file with no label that was admitted by its `.m4a`. An MP4 or 3GP
 * container holds sound alone as readily as a picture, and its tracks are
 * described in a box that may sit at the end of the file, so one admitted as
 * audio is stored as audio and anything else in it as video. A WebM says what
 * its tracks are near its start, so it is read: Chrome and Firefox label every
 * `.webm` from disk as video, a browser recorder's voice note included.
 *
 * Pure, and importing only a type: the tests feed it byte arrays.
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

/** `declaredAudio`: the file was admitted as audio (`declaredKind`). */
export function sniffWidgetFile(bytes: Uint8Array, declaredAudio: boolean): SniffedFile | null {
  if (bytes.length < 12) return null;

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
    const soundOnly = webmSoundOnly(bytes) ?? declaredAudio;
    return soundOnly ? audio('audio/webm', 'webm') : video('video/webm', 'webm');
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

/**
 * Whether a WebM holds sound and no picture, read from its `Tracks`; null when
 * they cannot be read within the first 64 KB — a muxer that put the clusters
 * first, or a file cut short — and the admitted kind decides instead.
 *
 * A walk of the element tree rather than a search for the `TrackType` id,
 * which is one byte (`0x83`) and so turns up in any payload: EBML header, then
 * the Segment's children up to `Tracks`, then each `TrackEntry`'s type, 1 for
 * video and 2 for audio. A track of any other kind — subtitles — changes
 * nothing.
 */
function webmSoundOnly(bytes: Uint8Array): boolean | null {
  const limit = Math.min(bytes.length, 64 * 1024);
  const header = readElement(bytes, 0, limit);
  if (header?.id !== 0x1a45dfa3 || header.size === null) return null;

  const segment = readElement(bytes, header.dataStart + header.size, limit);
  if (segment?.id !== 0x18538067) return null;
  const segmentEnd = endOf(segment, limit);

  for (let at = segment.dataStart; at < segmentEnd;) {
    const child = readElement(bytes, at, segmentEnd);
    if (!child) return null;
    if (child.id === EBML_TRACKS) {
      // Only a whole Tracks element is an answer: one cut at the limit could
      // be missing the video track after the sound.
      if (child.size === null || child.dataStart + child.size > limit) return null;
      return tracksSoundOnly(bytes, child.dataStart, child.dataStart + child.size);
    }
    // The clusters are the media itself; tracks after them are past reading.
    if (child.id === EBML_CLUSTER || child.size === null) return null;
    at = child.dataStart + child.size;
  }
  return null;
}

const EBML_TRACKS = 0x1654ae6b;
const EBML_CLUSTER = 0x1f43b675;
const EBML_TRACK_ENTRY = 0xae;
const EBML_TRACK_TYPE = 0x83;

function tracksSoundOnly(bytes: Uint8Array, start: number, end: number): boolean | null {
  let sound = false;
  for (let at = start; at < end;) {
    const entry = readElement(bytes, at, end);
    if (!entry || entry.size === null) return null;
    if (entry.id === EBML_TRACK_ENTRY) {
      const type = trackType(bytes, entry.dataStart, entry.dataStart + entry.size);
      if (type === 1) return false;
      if (type === 2) sound = true;
    }
    at = entry.dataStart + entry.size;
  }
  return sound ? true : null;
}

function trackType(bytes: Uint8Array, start: number, end: number): number | null {
  for (let at = start; at < end;) {
    const field = readElement(bytes, at, end);
    if (!field || field.size === null) return null;
    if (field.id === EBML_TRACK_TYPE) {
      let value = 0;
      for (let i = 0; i < field.size; i++) value = value * 256 + bytes[field.dataStart + i]!;
      return value;
    }
    at = field.dataStart + field.size;
  }
  return null;
}

type EbmlElement = { id: number; size: number | null; dataStart: number };

/**
 * One EBML element's head: its id, kept with its length marker as the spec
 * writes ids, and its size, null for the all-ones "unknown" a live recorder
 * writes for a Segment it is still filling. Null when the head does not fit
 * before `limit` or is not a valid one.
 */
function readElement(bytes: Uint8Array, at: number, limit: number): EbmlElement | null {
  const idLength = vintLength(bytes[at]);
  if (idLength === null || idLength > 4 || at + idLength > limit) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[at + i]!;

  const sizeAt = at + idLength;
  const sizeLength = vintLength(bytes[sizeAt]);
  if (sizeLength === null || sizeAt + sizeLength > limit) return null;
  let size = bytes[sizeAt]! & (0xff >> sizeLength);
  let unknown = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const byte = bytes[sizeAt + i]!;
    size = size * 256 + byte;
    unknown &&= byte === 0xff;
  }
  return { id, size: unknown ? null : size, dataStart: sizeAt + sizeLength };
}

/** How many bytes a variable-length integer takes, from its first byte's leading zeros. */
function vintLength(first: number | undefined): number | null {
  if (first === undefined || first === 0) return null;
  let length = 1;
  for (let mask = 0x80; (first & mask) === 0; mask >>= 1) length++;
  return length;
}

function endOf(element: EbmlElement, limit: number): number {
  return element.size === null ? limit : Math.min(limit, element.dataStart + element.size);
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
