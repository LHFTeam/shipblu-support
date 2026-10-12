import { metaWindowState } from '@/lib/meta/window';
import { formatRemaining, windowState } from '@/lib/whatsapp/window';
import { answeredFromConsole } from './channel-policy';
import type { InboxRow } from './inbox';

/**
 * The badges on an inbox row, decided before anything renders.
 *
 * A list rather than a component per badge so the avatar row can order them:
 * self-hiding badge components cannot tell their parent whether they drew
 * anything, and the order is the point — what is about to go wrong first, then
 * what somebody has to act on, then what the ticket merely is.
 *
 * Client-safe, like `inbox-lines`: the row type is erased and the two window
 * modules are pure. The tones are spelled out rather than imported from the
 * Badge, so `lib/` does not reach into `components/`; each is one of its
 * tones, which the row checks when it hands them over.
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
  | 'public';

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
  if ((row.channel === 'facebook' || row.channel === 'instagram') && !row.isComment) {
    const state = metaWindowState(last, now);
    if (state.isClosed) return { key: 'window', tone: 'window-closed', label: 'Window closed' };
    if (state.needsHumanAgentTag) return { key: 'window', tone: 'warning', label: 'Outside 24h' };
  }
  return null;
}

/**
 * `ticket` is the three-line row and keeps the order it always had — status,
 * window, priority, hub — with the comment marker last.
 *
 * `avatar` is ordered by urgency instead, and leaves out the default open
 * status, which most rows carry (a status an admin added to the open category,
 * such as "Escalated", is still shown): a window about to close and a hub that answered
 * are coral and lead, a closed window follows, then priority and the hub still
 * being waited on, then any other status. It is not capped at two as the design
 * system's row is: each of these is something an agent triages by, and a row
 * that wraps is cheaper than one that hides why the ticket is waiting.
 *
 * Only the answered hub state is loud. A ticket blocked on a hub looks
 * identical to one nobody has picked up, and "the hub answered an hour ago and
 * nobody noticed" is the failure the badge exists for: waiting is a fact,
 * replied is a job.
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
  // Answered in public, on the post, which the row would otherwise give no
  // sign of: the channel mark is the same for a comment and a message.
  const comment: RowBadge | null = row.isComment
    ? { key: 'comment', tone: 'public', label: 'Public comment' }
    : null;

  const ordered =
    layout === 'ticket'
      ? [status, window, priority, hub, comment]
      : [
          window?.tone === 'window-closing' ? window : null,
          hub?.tone === 'hub-replied' ? hub : null,
          window?.tone === 'window-closing' ? null : window,
          priority,
          hub?.tone === 'hub-replied' ? null : hub,
          row.statusCategory === 'open' && row.statusIsDefault ? null : status,
          comment,
        ];

  return ordered.filter((badge): badge is RowBadge => badge !== null);
}
