import { mimeEssence } from '@/lib/http/mime';

/**
 * Which attachments the console can show as a picture in the conversation, and
 * which it can try to play.
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
 *   Anywhere else a click would mint a signed URL and download the whole file
 *   only for the preview to say it cannot be shown, where a link hands the file
 *   straight over. The cost is an agent in Safari getting a link for a picture
 *   their browser could have drawn.
 * - **TIFF** is the same trade, and nobody photographs a parcel in it.
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
  return PREVIEWABLE.has(mimeEssence(contentType));
}

/** Recorded media the console offers to play, and the type to ask the browser about. */
export type PlayableMedia = { kind: 'audio' | 'video'; probe: string };

/**
 * Candidates only. Unlike a picture, whether these play is a question for the
 * browser, not for this list: an iPhone plays a WhatsApp voice note from iOS
 * 18.4 and not before, whatever browser it runs, so `canPlayType` with `probe`
 * decides in the console itself.
 *
 * Each is asked about with the codecs it arrives in, because a bare container
 * only ever answers "maybe" and so says nothing. `audio/ogg` is Opus, which
 * is what WhatsApp records a voice note in. MP4 is H.264 and AAC, which is what
 * WhatsApp and Messenger send. A Chromium built without those codecs says
 * "maybe" to a bare `video/mp4`, then fails to play every one. An iPhone video
 * may be HEVC instead, which the probe cannot see; one that will not decode
 * reaches the failure line, which keeps the link.
 *
 * Absent on purpose, so they stay download links:
 *
 * - **AMR**, the other thing WhatsApp can send as audio, which no browser
 *   decodes.
 * - **3GPP**. Chrome says "maybe" because it plays the H.264 and AAC it may
 *   hold, but a phone that records 3GP records H.263 and AMR, which nothing
 *   plays, and Firefox has no 3GP at all.
 *
 * A Map, not an object literal: the key is a sender's content type, and
 * `'__proto__'` read off a literal answers with `Object.prototype`.
 */
const PLAYABLE = new Map<string, PlayableMedia>([
  ['audio/ogg', { kind: 'audio', probe: 'audio/ogg; codecs="opus"' }],
  ['audio/mpeg', { kind: 'audio', probe: 'audio/mpeg' }],
  ['audio/mp4', { kind: 'audio', probe: 'audio/mp4; codecs="mp4a.40.2"' }],
  ['audio/x-m4a', { kind: 'audio', probe: 'audio/mp4; codecs="mp4a.40.2"' }],
  ['audio/aac', { kind: 'audio', probe: 'audio/aac' }],
  ['audio/wav', { kind: 'audio', probe: 'audio/wav' }],
  ['audio/webm', { kind: 'audio', probe: 'audio/webm' }],
  ['video/mp4', { kind: 'video', probe: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"' }],
  ['video/webm', { kind: 'video', probe: 'video/webm' }],
  ['video/quicktime', { kind: 'video', probe: 'video/quicktime; codecs="avc1.42E01E, mp4a.40.2"' }],
]);

export function playableMedia(contentType: string): PlayableMedia | null {
  return PLAYABLE.get(mimeEssence(contentType)) ?? null;
}
