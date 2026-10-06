/**
 * How long the Storage URL behind `/api/attachments/[id]` lasts, and when a
 * player has to go back for another.
 *
 * The route signs with this, so the two cannot drift. It is short because a
 * ticket attachment can be an ID document, and a URL that reaches the browser
 * should stop working soon after. That holds at the Storage origin, which
 * checks the signature as each request starts. It is not a revocation: the
 * project's plan puts Supabase's Smart CDN in front of Storage, and a response
 * the edge has cached for a URL is served for that same URL after its token has
 * expired. Only deleting the object cuts that off.
 */
export const ATTACHMENT_URL_TTL_SECONDS = 300;

/**
 * A minute short of the TTL, so a range request that starts just before the
 * deadline is not answered with the expiry.
 */
const REFRESH_AFTER_MS = (ATTACHMENT_URL_TTL_SECONDS - 60) * 1000;

export type MediaTrigger = 'play' | 'seeking' | 'waiting' | 'stalled' | 'error';

/** `MediaError` codes, named here because the constants exist only in a browser. */
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;

/** `HTMLMediaElement.HAVE_FUTURE_DATA`: enough to play on from the position. */
const HAVE_FUTURE_DATA = 3;

/** How much buffered time ahead of the position counts as not needing the network. */
const AHEAD_SECONDS = 1;

/**
 * How recently bytes must have arrived for a stall to be a slow response rather
 * than a refused one. Chrome's own `stalled` fires after three seconds without
 * data, so a stall that outlasts this is still caught, by that event.
 */
const LIVE_DATA_MS = 3000;

/**
 * Whether a playing `<audio>` or `<video>` should reload through the route
 * before it asks Storage for another range.
 *
 * It has to ask, because no browser goes back through the route by itself.
 * After the 307, every later range request goes straight to the signed URL —
 * Chrome and Firefox both measured, Safari reported — so a pause longer than
 * the TTL, or a seek past what was buffered once the TTL has passed, asks
 * Storage with a dead signature. Unless the edge cached that exact request, the
 * origin answers 400 with a JSON body. Chrome's response blocking hides that
 * body as a network failure, and the element then retries for about half a
 * minute before it reports an error at all. So this decides before the request
 * instead of after.
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
 * - **A young URL** is trusted through a play, a seek or a stall: a stall on
 *   one is a slow network, and reloading would only start the wait again.
 * - **A play or a seek on an old URL** reloads when the position has nothing
 *   buffered ahead of it — at least a second, or to the end — because that
 *   position needs a new request. A voice note arrives whole in one response,
 *   so replaying one an hour later needs no request at all.
 * - **A `waiting` on an old URL** is judged the same way, unless bytes arrived
 *   in the last few seconds. Chrome fires it on every seek, into buffered data
 *   too, so it is not starvation on its own: treating it as such reloaded a
 *   voice note being replayed from memory and cut the replay off. And Storage
 *   checks the signature only as a request starts, then streams the rest, so a
 *   response that began before the deadline keeps arriving after it. A stall
 *   while it does is a slow link, and a reload would throw a live stream away
 *   to start the wait again.
 * - **A `stalled` on an old URL** reloads when the element cannot play on
 *   (`readyState` below `HAVE_FUTURE_DATA`), whatever `buffered` says. It
 *   fires only while the element is fetching and nothing has arrived for
 *   about three seconds, which on an old URL is the dead signature being
 *   retried. `buffered` cannot be trusted to say so: for a plain `src` MP4,
 *   Chrome maps the bytes received linearly onto the duration, and a `moov`
 *   at the head of the file puts the reported edge a second or two past where
 *   playback actually starves — measured at 1.3 to 2.5 seconds, enough to let
 *   the `waiting` through and freeze the picture for half a minute. A note
 *   held whole in memory is not fetching, so it never sees one.
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
    /** `HTMLMediaElement.readyState`, for a stall. */
    readyState?: number;
    /** Time since the element last reported bytes arriving, null if it never has. */
    sinceDataMs?: number | null;
  },
): boolean {
  if (media.ageMs === null) return false;
  if (trigger === 'error') {
    if (media.errorCode === MEDIA_ERR_NETWORK) return true;
    return media.errorCode === MEDIA_ERR_DECODE && media.ageMs >= REFRESH_AFTER_MS;
  }
  if (media.ageMs < REFRESH_AFTER_MS) return false;
  if (trigger === 'stalled') return (media.readyState ?? HAVE_FUTURE_DATA) < HAVE_FUTURE_DATA;
  if (trigger === 'waiting' && media.sinceDataMs != null && media.sinceDataMs < LIVE_DATA_MS) {
    return false;
  }
  return !media.buffered.some(
    ([start, end]) =>
      start <= media.position && (end - media.position >= AHEAD_SECONDS || end >= media.duration),
  );
}

/**
 * How long a player waits before the reload it is about to make, counting the
 * reloads made because of an error in a row, this one included.
 *
 * The first goes at once: one error after metadata is most often a connection
 * that dropped on a network that is still there. A reload that itself failed is
 * different. Firefox reports a failed request at once and does not retry, so
 * while the network is down each reload fails within milliseconds, and three
 * made back to back spent the whole allowance inside a single short outage.
 * Spacing them out turns the cap into seconds of outage rather than round
 * trips.
 */
export function reloadDelayMs(failedReloads: number): number {
  return failedReloads <= 1 ? 0 : 1000 * 2 ** (failedReloads - 2);
}
