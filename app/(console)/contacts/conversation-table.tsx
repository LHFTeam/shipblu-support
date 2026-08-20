import Link from 'next/link';
import { Badge, Cell, EmptyState, Row, Table } from '@/components/ui';
import { ChannelBadge } from '@/components/channel';
import { formatRelative } from '@/lib/format';
import type { ConversationSummary } from '@/lib/shipments/queries';

/**
 * The conversation list every contact-side page shows.
 *
 * One component so a ticket looks the same on a contact, an account and a
 * shipment. The rows are already visibility-filtered by whichever query
 * produced them — see `conversationVisibility` — because a template is the wrong
 * place to be deciding who may see what.
 */
export function ConversationTable({
  conversations,
  emptyTitle,
  emptyHint,
}: {
  conversations: ConversationSummary[];
  emptyTitle: string;
  emptyHint?: string;
}) {
  if (conversations.length === 0) {
    return <EmptyState title={emptyTitle} hint={emptyHint} />;
  }

  return (
    <Table head={['Ticket', 'Subject', 'Channel', 'Status', 'Assignee', 'Last activity']}>
      {conversations.map((conversation) => (
        <Row key={conversation.id}>
          <Cell>
            <Link href={`/inbox/${conversation.number}`} className="font-medium hover:underline">
              #{conversation.number}
            </Link>
          </Cell>
          <Cell className="max-w-xs truncate">{conversation.subject ?? '(no subject)'}</Cell>
          <Cell>
            <ChannelBadge channel={conversation.channel} />
          </Cell>
          <Cell>
            <Badge tone={conversation.statusCategory}>{conversation.statusName}</Badge>
          </Cell>
          <Cell className="text-xs text-[var(--muted-foreground)]">
            {conversation.assigneeName ?? 'Unassigned'}
          </Cell>
          <Cell className="text-xs whitespace-nowrap text-[var(--muted-foreground)]">
            {formatRelative(conversation.lastMessageAt)}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}
