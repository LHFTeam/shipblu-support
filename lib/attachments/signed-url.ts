/**
 * How long the Storage URL behind `/api/attachments/[id]` lasts, and when a
 * player has to go back for another.
 *
 * The route signs with this, so the two cannot drift. It is short because a
 * ticket attachment can be an ID document, and a URL that reaches the browser
 * should stop working soon after.
 */
export const ATTACHMENT_URL_TTL_SECONDS = 300;

/**
 * A minute short of the TTL, so a range request that starts just before the
 * deadline is not answered with the expiry.
 */
const REFRESH_AFTER_MS = (ATTACHMENT_URL_TTL_SECONDS - 60) * 1000;

export type MediaTrigger = 'play' | 'seeking' | 'waiting' | 'error';

/** `MediaError` codes, named here because the constants exist only in a browser. */
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;

/** How much buffered time ahead of the position counts as not needing the network. */
const AHEAD_SECONDS = 1;

/**
 * Whether a playing `<audio>` or `<video>` should reload through the route
 * before it asks Storage for another range.
 *
 * It has to ask, because no browser goes back through the route by itself.
 * After the 307, every later range request goes straight to the signed URL —
 * Chrome and Firefox both measured, Safari reported — so a pause longer than
 * the TTL, or a seek past what was buffered once the TTL has passed, asks
 * Storage with a dead signature. Storage answers 400 with a JSON body. Chrome's response blocking
 * hides that body as a network failure, and the element then retries for about
 * half a minute before it reports an error at all. So this decides before the
 * request instead of after.
 *
 * `ageMs` is time since the URL was minted, and null when no signed URL is in
 * play: before the first metadata, nothing has been signed for this element, or
 * a reload is already under way.
 *
 * - **A network error after metadata** reloads at any age. The URL was good
 *   once, so it expired or the connection dropped, and a fresh one answers
 *   both. Chrome reports the expiry this way once its retries run out, and
 *   Firefox at once.
 * - **A decode error** reloads only on an old URL. Safari has been reported to
 *   surface a failed range as a decode error rather than a network one. On a
 *   young URL, though, a decode error is the file itself, and reloading it
 *   would only fail again.
 * - **Any other error** — the source refused outright — never reloads.
 * - **A play, a seek or a stall** reloads only once the URL is old and the
 *   position has nothing buffered ahead of it — at least a second, or to the
 *   end. "Waiting" is not evidence of starvation on its own: Chrome fires it on
 *   every seek, into buffered data too, and treating it as starvation reloaded
 *   a voice note being replayed from memory and cut the replay off. Starvation
 *   is a position at the edge of what was buffered, which this catches.
 *   A voice note arrives whole in one response, so replaying one an hour later
 *   needs no request at all.
 * - **A young URL** is trusted: a stall on one is a slow network, and reloading
 *   would only start the wait again.
 */
export function shouldRefresh(
  trigger: MediaTrigger,
  media: {
    ageMs: number | null;
    position: number;
    duration: number;
    buffered: ReadonlyArray<readonly [number, number]>;
    /** `MediaError.code`, for an error. */
    errorCode?: number | null;
  },
): boolean {
  if (media.ageMs === null) return false;
  if (trigger === 'error') {
    if (media.errorCode === MEDIA_ERR_NETWORK) return true;
    return media.errorCode === MEDIA_ERR_DECODE && media.ageMs >= REFRESH_AFTER_MS;
  }
  if (media.ageMs < REFRESH_AFTER_MS) return false;
  return !media.buffered.some(
    ([start, end]) =>
      start <= media.position && (end - media.position >= AHEAD_SECONDS || end >= media.duration),
  );
}
