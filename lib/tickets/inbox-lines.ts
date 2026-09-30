import { hasWrittenSubject } from './channel-policy';
import type { InboxRow } from './inbox';

/**
 * The inbox card's lines of text: the last thing said, by either side — the
 * arrow beside the assignee says whose it is.
 *
 * Under a subject only where the ticket has one of its own, email and the
 * portal, and not repeated when the message is only the subject again, as mail
 * from a phone often is. Everywhere else the subject is the opening message's
 * text, and showing it put the first and the latest message on one card; there
 * it is only the fallback for a ticket with no text to show yet. `||` rather
 * than `??` throughout for that reason: `body_text` is never null, only empty.
 *
 * Out of the list component so it can be tested without a DOM, and client-safe
 * like `inbox-position` beside it: the row type is erased, and the channel rule
 * comes from `channel-policy`, which the list already imports.
 */
export function messageLines(row: Pick<InboxRow, 'channel' | 'subject' | 'preview'>): {
  headline: string;
  secondary: string | null;
} {
  if (hasWrittenSubject(row.channel)) {
    return {
      headline: row.subject || '(no subject)',
      secondary: row.preview && row.preview !== row.subject ? row.preview : null,
    };
  }
  return { headline: row.preview || row.subject || '(no subject)', secondary: null };
}
