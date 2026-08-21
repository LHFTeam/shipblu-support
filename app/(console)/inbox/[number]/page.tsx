import { notFound } from 'next/navigation';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { listSideConversationRecipients } from '@/lib/side-conversations/queries';
import {
  getConversation,
  listActiveAgents,
  listApprovedTemplates,
  listGroups,
  listStatuses,
} from '@/lib/tickets/queries';
import { InboxShell } from '../shell';
import { FocusBeat } from './focus';
import { ConversationView } from './view';

export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ number: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ number }, query] = await Promise.all([params, searchParams]);

  const ticketNumber = Number(number);
  if (!Number.isInteger(ticketNumber) || ticketNumber <= 0) notFound();

  const agent = await requireAgent();
  const conversation = await getConversation(agent, ticketNumber);

  // getConversation applies the agent's visibility rule, so a ticket they may
  // not see is indistinguishable from one that does not exist — which is the
  // behaviour we want.
  if (!conversation) notFound();

  const canSideConversation = can(agent, 'ticket.side_conversation');

  const [statuses, agentList, groupList, templates, recipients] = await Promise.all([
    listStatuses(),
    listActiveAgents(),
    listGroups(),
    // Only fetched for WhatsApp tickets: an email ticket has no use for them
    // and the table is synced hourly, so this is a needless query otherwise.
    conversation.channel === 'whatsapp' ? listApprovedTemplates() : Promise.resolve([]),
    // Same reasoning: an agent who cannot start one has no picker to fill.
    canSideConversation ? listSideConversationRecipients() : Promise.resolve([]),
  ]);

  return (
    <InboxShell searchParams={query} activeNumber={ticketNumber}>
      <ConversationView
        conversation={conversation}
        statuses={statuses}
        agents={agentList}
        groups={groupList}
        templates={templates}
        recipients={recipients}
        canSideConversation={canSideConversation}
        currentAgentId={agent.id}
      />
      <FocusBeat conversationId={conversation.id} />
    </InboxShell>
  );
}
