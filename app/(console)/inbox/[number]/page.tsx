import { notFound } from 'next/navigation';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { listSideConversationRecipients } from '@/lib/side-conversations/queries';
import {
  getConversation,
  listActiveAgents,
  listApprovedTemplates,
  listCannedResponses,
  listGroups,
  listStatuses,
  listTicketFields,
} from '@/lib/tickets/queries';
import { accountIdForConversation } from '@/lib/whatsapp/conversation';
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

  // Which business account this ticket's number belongs to, because that is
  // what decides the templates the agent may pick — not the installation.
  const whatsappAccountId =
    conversation.channel === 'whatsapp' ? await accountIdForConversation(conversation.id) : null;

  const [statuses, agentList, groupList, fields, canned, templates, recipients] = await Promise.all(
    [
      listStatuses(),
      listActiveAgents(),
      listGroups(),
      listTicketFields(),
      listCannedResponses(agent),
      // Only fetched for WhatsApp tickets: an email ticket has no use for them
      // and the table is synced hourly, so this is a needless query otherwise.
      conversation.channel === 'whatsapp'
        ? listApprovedTemplates(whatsappAccountId)
        : Promise.resolve([]),
      // Same reasoning: an agent who cannot start one has no picker to fill.
      canSideConversation ? listSideConversationRecipients() : Promise.resolve([]),
    ],
  );

  return (
    <InboxShell
      searchParams={query}
      activeNumber={ticketNumber}
      activeConversationId={conversation.id}
    >
      <ConversationView
        conversation={conversation}
        statuses={statuses}
        agents={agentList}
        groups={groupList}
        fields={fields}
        canned={canned}
        templates={templates}
        recipients={recipients}
        canSideConversation={canSideConversation}
        currentAgentId={agent.id}
      />
      <FocusBeat conversationId={conversation.id} />
    </InboxShell>
  );
}
