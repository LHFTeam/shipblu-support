import { formatTime } from '@/lib/format';
import { metaWindowState } from '@/lib/meta/window';
import { isWorkable } from '@/lib/routing/decide';
import { isHeld, type HoldColumns } from '@/lib/routing/hold';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import { answeredFromConsole, isMetaChannel } from './channel-policy';
import type { InboxRow } from './inbox';
import type { StatusCategory } from './vocabulary';

/**
 * The badges on an inbox row, decided before anything renders.
 *
 * A list rather than a component per badge so the avatar row can order them:
 * self-hiding badge components cannot tell their parent whether they drew
 * anything, and the order is the point — what is about to go wrong first, then
 * what somebody has to act on, then what the ticket merely is.
 *
 * Client-safe, like `inbox-lines`: the row type is erased, and the two window
 * modules, the hold and `lib/format.ts` are pure. The tones are spelled out
 * rather than imported from the Badge, so `lib/` does not reach into
 * `components/`; each is one of its tones, which the row checks when it hands
 * them over.
 */

type RowBadgeTone =
  | InboxRow['statusCategory']
  | 'window-closing'
  | 'window-closed'
  | 'warning'
  | 'priority-high'
  | 'priority-urgent'
  | 'hub-waiting'
  | 'hub-replied'
  | 'public'
  | 'automated'
  | 'neutral';

export type RowBadge = { key: string; tone: RowBadgeTone; label: string };

type BadgeRow = Pick<
  InboxRow,
  | 'channel'
  | 'isComment'
  | 'lastCustomerMessageAt'
  | 'statusCategory'
  | 'statusName'
  | 'statusIsDefault'
  | 'priority'
  | 'sideState'
  | 'categoryLabel'
  | 'assigneeId'
  | 'routingUntil'
  | 'isSpam'
>;

/** Under two hours is when a WhatsApp window starts mattering; above that it is noise. */
const CLOSING_MS = 2 * 60 * 60 * 1000;

/**
 * The messaging window, where there is one an agent can act on — the same rules
 * the ticket header applies, so the list and the open ticket cannot disagree.
 *
 * `now` is null until the list has mounted, and then no window badge is drawn:
 * a countdown computed on the server would be wrong by the time it arrived.
 */
function windowBadge(row: BadgeRow, now: Date | null): RowBadge | null {
  if (!now) return null;
  const last = row.lastCustomerMessageAt ? new Date(row.lastCustomerMessageAt) : null;

  // No window where nobody replies from here.
  if (row.channel === 'whatsapp' && answeredFromConsole(row.channel)) {
    const state = windowState(last, now);
    if (!state.isOpen) return { key: 'window', tone: 'window-closed', label: 'Window closed' };
    if (state.remainingMs < CLOSING_MS) {
      return { key: 'window', tone: 'window-closing', label: formatRemaining(state.remainingMs) };
    }
    return null;
  }

  // A comment ticket is answered on the comment edge and has no messaging
  // window. The first 24 hours are unremarkable, so nothing is drawn for them.
  if (isMetaChannel(row.channel) && !row.isComment) {
    const state = metaWindowState(last, now);
    if (state.isClosed) return { key: 'window', tone: 'window-closed', label: 'Window closed' };
    if (state.needsHumanAgentTag) return { key: 'window', tone: 'warning', label: 'Outside 24h' };
  }
  return null;
}

/**
 * What `routingHold` reads: the hold's three columns, and whether the ticket
 * is still work the router would move.
 */
export type HoldTicket = HoldColumns & {
  statusCategory: StatusCategory;
  isSpam: boolean;
  mergedIntoId: string | null;
};

/**
 * The routing hold, as everything that draws it reads it — the list row, the
 * ticket header and the sidebar's hints — so the list and the open ticket
 * cannot disagree about whether a ticket is held, which is the rule
 * `windowBadge` states for the window. Null when it is not held.
 *
 * Only on work, asked of the router's own `isWorkable` — open or pending, and
 * not spam or merged — so the badge and `not_open` cannot come apart; a
 * deleted ticket reaches no reader, so nothing here carries its stamp. No
 * status, spam or merge writer ends a hold, so a held ticket resolved in its
 * window keeps the window on its row until `settle_routing` records
 * `not_open`, and nothing routes it meanwhile: a category chosen then decides
 * `not_open` at once. "Routing…" on it, and "choosing its category now routes
 * it" beside it, would promise a route that never comes. Reopened inside the
 * window, it is work again and held again, which is what the columns say.
 *
 * Drawn before the list has a clock, unlike the window: with `now` null it
 * reads the columns alone — a window opened, nothing decided, nobody holding
 * the ticket — which the server and the browser agree on, and "do not take
 * this yet" is worth having on the first paint. The clock adds the two things
 * only it can know: the grace running out on a stuck job, which writes nothing
 * and so is never read off a column, and whether the window is still ahead,
 * which `until` carries.
 *
 * `routingWindowEndsAt` is read through `new Date()`, because an inbox row
 * from `/api/inbox` crossed JSON, and a string the type still calls a `Date`
 * would throw in `isHeld`.
 */
export function routingHold(ticket: HoldTicket, now: Date | null): { until: Date | null } | null {
  if (!isWorkable({ ...ticket, deletedAt: null })) return null;
  const endsAt = ticket.routingWindowEndsAt ? new Date(ticket.routingWindowEndsAt) : null;
  if (!endsAt || ticket.routingDecidedAt || ticket.assigneeAgentId) return null;
  if (now && !isHeld({ ...ticket, routingWindowEndsAt: endsAt }, now)) return null;
  return { until: now && now.getTime() < endsAt.getTime() ? endsAt : null };
}

/**
 * The hold in words: when the window ends while it is still ahead, and the
 * bare word after it — the settle is due, and its time has passed — or before
 * there is a clock to say which. `formatTime` is the Cairo wall clock, the same
 * on the server and in the browser.
 */
export function routingLabel(hold: { until: Date | null }): string {
  return hold.until ? `Routing until ${formatTime(hold.until)}` : 'Routing…';
}

/**
 * `ticket` is the three-line row and keeps the order it always had — status,
 * window, priority, hub — with the routing hold after the status, and the
 * comment marker and then the category last.
 *
 * `avatar` is ordered by urgency instead, and leaves out the default open
 * status, which most rows carry (a status an admin added to the open category,
 * such as "Escalated", is still shown): a window about to close and a hub that answered
 * are coral and lead, a closed window follows, then priority and the hub still
 * being waited on, then any other status. It is not capped at two as the design
 * system's row is: each of these is something an agent triages by, and a row
 * that wraps is cheaper than one that hides why the ticket is waiting.
 *
 * The routing hold follows those two in the avatar row: "do not take this
 * yet" is triage, since an agent who takes a held ticket ends its route, but
 * it is not an alarm — dashed, the console's sign for a machine at work, and
 * never coral. Its words carry it, as colour alone never may.
 *
 * Only the answered hub state is loud. A ticket blocked on a hub looks
 * identical to one nobody has picked up, and "the hub answered an hour ago and
 * nobody noticed" is the failure the badge exists for: waiting is a fact,
 * replied is a job.
 *
 * The category closes both rows. It is the one badge that is only what the
 * ticket is: nothing about it is going wrong or waiting on anybody, and unlike
 * the comment marker before it, it changes nothing about how the reply goes
 * out. In a list cut to one category every row carries the same one, and the
 * end of the line is where a repeated word costs least to read past.
 */
export function rowBadges(
  row: BadgeRow,
  now: Date | null,
  layout: 'avatar' | 'ticket',
): RowBadge[] {
  const window = windowBadge(row, now);

  const status: RowBadge = { key: 'status', tone: row.statusCategory, label: row.statusName };
  const priority: RowBadge | null =
    row.priority === 'urgent'
      ? { key: 'priority', tone: 'priority-urgent', label: 'Urgent' }
      : row.priority === 'high'
        ? { key: 'priority', tone: 'priority-high', label: 'High' }
        : null;
  const hub: RowBadge | null =
    row.sideState === 'replied'
      ? { key: 'hub', tone: 'hub-replied', label: 'Hub replied' }
      : row.sideState === 'waiting'
        ? { key: 'hub', tone: 'hub-waiting', label: 'Awaiting hub' }
        : null;
  // Answered in public, on the post. The comment channels have marks of their
  // own, but both row layouts draw the mark without its label, and a shape is
  // not a sentence: the words say it, as colour alone never may.
  const comment: RowBadge | null = row.isComment
    ? { key: 'comment', tone: 'public', label: 'Public comment' }
    : null;
  // Neutral, as the ticket header's is: a category is nobody's alarm, and no
  // colour belongs to one, so its name is the whole of what it says. Nothing
  // is drawn while none is set.
  const category: RowBadge | null = row.categoryLabel
    ? { key: 'category', tone: 'neutral', label: row.categoryLabel }
    : null;
  const hold = routingHold(
    {
      routingWindowEndsAt: row.routingUntil,
      routingDecidedAt: null,
      assigneeAgentId: row.assigneeId,
      statusCategory: row.statusCategory,
      isSpam: row.isSpam,
      // `listInbox` lists no merged ticket.
      mergedIntoId: null,
    },
    now,
  );
  const routing: RowBadge | null = hold
    ? { key: 'routing', tone: 'automated', label: routingLabel(hold) }
    : null;

  const ordered =
    layout === 'ticket'
      ? [status, routing, window, priority, hub, comment, category]
      : [
          window?.tone === 'window-closing' ? window : null,
          hub?.tone === 'hub-replied' ? hub : null,
          routing,
          window?.tone === 'window-closing' ? null : window,
          priority,
          hub?.tone === 'hub-replied' ? null : hub,
          row.statusCategory === 'open' && row.statusIsDefault ? null : status,
          comment,
          category,
        ];

  return ordered.filter((badge): badge is RowBadge => badge !== null);
}
