import { PREVIEW_CHARS } from './schemas';

/**
 * How much of a message a list row shows (`ticket.preview.text`): its first
 * `PREVIEW_CHARS` UTF-16 code units, the unit every limit in the contract counts
 * in, and one fewer where the last of them would be the first half of a
 * surrogate pair. Half a character is a lone surrogate, which JSON carries only
 * escaped, a list row draws as a replacement mark, and some decoders refuse
 * outright. Cut and never ellipsised: the app draws its own.
 */
export function previewText(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  const last = text.charCodeAt(PREVIEW_CHARS - 1);
  const splits = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splits ? PREVIEW_CHARS - 1 : PREVIEW_CHARS);
}
