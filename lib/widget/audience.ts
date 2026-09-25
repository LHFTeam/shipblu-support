import { getSessionAgent } from '@/lib/auth/session';

/**
 * Whether the person reading a page we render is one of us.
 *
 * The chat launcher is a customer's way in, and the help centre is not only a
 * customer's surface: the console's knowledge panel opens articles there, the
 * team reads and screenshots them all day, and the hostname serving the console
 * serves the help centre too. So a signed-in agent got a floating chat button
 * over every article, one click from opening a webchat ticket against their own
 * queue — a `contacts` row and a conversation with no customer behind either,
 * in the tables the reports are drawn from.
 *
 * Three things about the shape of this, each a decision rather than an
 * implementation detail:
 *
 * - **It reads the session, not the cookie.** `proxy.ts` may check only that
 *   the cookie exists, because the page behind it re-checks; here the failure
 *   runs the other way round. A stale or revoked cookie left in a browser would
 *   take live chat away from whoever sits at it next, silently and for good —
 *   nothing on the page says a launcher is missing. It costs a customer
 *   nothing: `getSessionAgent()` answers null before it queries anything when
 *   there is no cookie.
 * - **It decides what we render, never what we serve.** `/widget` and
 *   `/api/widget/*` stay open to a signed-in agent, because the launcher on a
 *   merchant's own site is drawn by a snippet we cannot take back — and a frame
 *   that refused them there would leave that button opening an empty box, which
 *   is worse than a chat they did not want.
 * - **A host page that is not ours is out of scope.** The only response that
 *   could carry this to one is `embed.js`, served `public, max-age=300`:
 *   varying it per viewer means either giving up that cache on every page of
 *   every site carrying the widget, or letting a shared cache hand one viewer's
 *   answer to the next reader. A wrong answer there is served to other people,
 *   which is the wrong failure to buy.
 */
export async function viewerIsTeamMember(): Promise<boolean> {
  return (await getSessionAgent()) !== null;
}
