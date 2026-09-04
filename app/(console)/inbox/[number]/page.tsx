import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { suggestForAgent } from '@/lib/kb/agent-search';
import { detectLocale } from '@/lib/kb/language';
import { seedTerms } from '@/lib/kb/seed';
import { requestBaseUrl } from '@/lib/kb/site';
import { categoryOptions, rootCauseOptions } from '@/lib/categorise/queries';
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
import { readOnlyReason } from '@/lib/tickets/channel-policy';
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
  const canModerateComments = can(agent, 'ticket.moderate_comment');
  const canEditContact = can(agent, 'contact.edit');
  const canClose = can(agent, 'ticket.close');
  const canCategorise = can(agent, 'ticket.categorise');

  // Read whatever the permission, because the sidebar shows what a ticket is
  // filed under to anybody who can open it — `ticket.categorise` gates changing
  // it, not seeing it.
  const [categories, causes] = await Promise.all([categoryOptions(), rootCauseOptions()]);

  /*
    What the ticket suggests it is about, for the composer's knowledge panel.

    Both halves are read off the conversation that is already loaded, so
    building them costs nothing; only the article lookup is a query, and it is
    skipped entirely when the agent cannot see the knowledge base or the channel
    has no composer to insert into.

    The language comes from the script of what the customer actually wrote, not
    from `contacts.locale` — that column is written by nothing and reads 'en'
    for all six thousand contacts, so trusting it would search the English
    articles for every Arabic ticket in the system.

    It is also what the composer's canned-response picker starts on, and it is
    handed over separately from the panel: the two are the same question asked
    once, and an agent without `kb.view` still needs the answer.
  */
  const lastInbound = [...conversation.messages]
    .reverse()
    .find((message) => message.direction === 'inbound' && message.kind === 'reply');

  const wantsKnowledge = can(agent, 'kb.view') && !readOnlyReason(conversation.channel);
  const kbLocale = detectLocale(lastInbound?.bodyText, conversation.subject);
  const terms = wantsKnowledge ? seedTerms(conversation.subject, lastInbound?.bodyText) : [];

  // The host this agent is actually on, so the article they open and the link
  // they paste both resolve. `publicBaseUrl()` names the address we publish,
  // which is only the same thing once that domain serves this app.
  const kbOrigin = requestBaseUrl(await headers());

  // Which business account this ticket's number belongs to, because that is
  // what decides the templates the agent may pick — not the installation.
  const whatsappAccountId =
    conversation.channel === 'whatsapp' ? await accountIdForConversation(conversation.id) : null;

  const [statuses, agentList, groupList, fields, canned, templates, recipients, suggestions] =
    await Promise.all([
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
      // `seedTerms` returns nothing when the ticket is a greeting or a photo,
      // and `suggestForAgent` returns nothing for fewer than two terms — so a
      // ticket with nothing to go on costs no query and renders no panel
      // furniture, the same way the help centre's blocks remove themselves.
      terms.length ? suggestForAgent(kbOrigin, agent.role, kbLocale, terms) : Promise.resolve([]),
    ]);

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
        customerLocale={kbLocale}
        knowledge={wantsKnowledge ? { suggestions, locale: kbLocale } : null}
        templates={templates}
        recipients={recipients}
        canSideConversation={canSideConversation}
        canModerateComments={canModerateComments}
        canEditContact={canEditContact}
        canClose={canClose}
        canCategorise={canCategorise}
        categoryOptions={categories}
        rootCauses={causes}
        currentAgentId={agent.id}
      />
      <FocusBeat conversationId={conversation.id} />
    </InboxShell>
  );
}
