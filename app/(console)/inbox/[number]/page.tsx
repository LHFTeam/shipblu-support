import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { previewConversationPurge } from '@/lib/admin/purge';
import { hiddenScopeRefusal } from '@/lib/admin/purge-visibility';
import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { toCategoryChoices } from '@/lib/categories/choices';
import { listCategories } from '@/lib/categories/queries';
import { suggestForAgent } from '@/lib/kb/agent-search';
import { detectLocale } from '@/lib/kb/language';
import { seedTerms } from '@/lib/kb/seed';
import { requestBaseUrl } from '@/lib/kb/site';
import { subcategoryOptions, rootCauseOptions } from '@/lib/subcategorise/queries';
import { listSideConversationRecipients } from '@/lib/side-conversations/queries';
import { getConversation } from '@/lib/tickets/conversation';
import { lastCustomerWords, subjectWords } from '@/lib/tickets/customer-text';
import {
  listActiveAgents,
  listApprovedTemplates,
  listCannedResponses,
  listGroups,
  listStatuses,
  listTicketFields,
} from '@/lib/tickets/lookups';
import { answeredFromConsole } from '@/lib/tickets/channel-policy';
import { suggestionsLive } from '@/lib/canned-suggest/settings';
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
  // Whether the details column's Contact tab may link to the contact's page.
  const canViewContact = can(agent, 'contact.view');
  const canClose = can(agent, 'ticket.close');
  const canSubcategorise = can(agent, 'ticket.subcategorise');
  const canSetCategory = can(agent, 'ticket.set_category');

  // Read whatever the permission, because the sidebar shows what a ticket is
  // filed under to anybody who can open it — `ticket.subcategorise` gates
  // changing it, not seeing it.
  const mayPurge = can(agent, 'ticket.purge');
  const [subcategories, causes, categories, purgePreview, purgeRefusal] = await Promise.all([
    subcategoryOptions(),
    rootCauseOptions(),
    // For the sidebar's select, which every role holds `ticket.set_category`
    // for. No extra query: it is memoised for the request, and the inbox shell
    // around this page reads it for its filter.
    listCategories(),
    // Counted on render rather than on click, because the counts are the whole
    // argument the confirmation panel makes and a panel that has to fetch before
    // it can warn is a panel that gets clicked through. Only for an admin who
    // could act on it — this is several counting queries, and everybody else
    // would pay for them to render nothing.
    mayPurge ? previewConversationPurge(conversation.id) : Promise.resolve(null),
    // The ticket itself passed the visibility rule to get this far; what it
    // would take with it — tickets merged into it — has not.
    mayPurge
      ? hiddenScopeRefusal(agent, { conversationId: conversation.id })
      : Promise.resolve(null),
  ]);

  /*
    What the ticket suggests it is about, for the composer's knowledge panel.

    Both halves are read off the conversation that is already loaded, so
    building them costs nothing; only the article lookup is a query, and it is
    skipped entirely when the agent cannot see the knowledge base or the channel
    has no composer to insert into.

    The language comes from the script of what the customer actually wrote, not
    from `contacts.locale` — that column is written by nothing and reads 'en'
    for every contact, so trusting it would search the English articles for
    every Arabic ticket in the system. Nor from our own label for a photo or a
    voice message sent without a caption: its letters are English, and a
    one-word label sent the search back to the subject, a longer one searched
    for our own words. A ticket whose newest message is a photo opens on the
    customer's words before it, as `requesterLocale` does for a reply nobody
    watches go out. The subject is read the same way, because a chat
    ticket's subject is its opening message's first line, and one that opened
    with a photo is called `[image]` — or, with no first line, by a name ingest
    gave it, such as `Instagram comment`.

    It is also what the composer's canned-response picker starts on, and it is
    handed over separately from the panel: the two are the same question asked
    once, and an agent without `kb.view` still needs the answer. A canned
    suggestion records the same reading as the language it was asked in
    (`lib/canned-suggest/suggest.ts`), so its report splits on what the agent
    saw.
  */
  const lastInbound = lastCustomerWords(conversation.messages);
  const subject = subjectWords(conversation.subject);

  // The panel lives in the reply form, so a ticket with no reply box (read-only,
  // or a channel not answered from here) has nowhere to show it.
  const answersHere = answeredFromConsole(conversation.channel);
  const wantsKnowledge = can(agent, 'kb.view') && answersHere;
  const kbLocale = detectLocale(lastInbound?.bodyText, subject);
  const terms = wantsKnowledge ? seedTerms(subject, lastInbound?.bodyText) : [];

  // The host this agent is actually on, so the article they open and the link
  // they paste both resolve. `publicBaseUrl()` names the address we publish,
  // which is only the same thing once that domain serves this app.
  const kbOrigin = requestBaseUrl(await headers());

  // Whether the reply box asks Jev for a canned response: only where there is a
  // reply box, for an agent who may reply, and while the admin switch is on and
  // this environment holds a key. The switch is memoised, so this is not a query
  // on most renders.
  const mayReply = can(agent, 'ticket.reply') && answersHere;

  const [statuses, agentList, groupList, fields, canned, templates, recipients, suggestions, live] =
    await Promise.all([
      listStatuses(),
      listActiveAgents(),
      listGroups(),
      listTicketFields(),
      // Only the reply form inserts one, so no reply box, no list.
      answersHere ? listCannedResponses(agent) : Promise.resolve([]),
      // Only fetched for WhatsApp tickets: an email ticket has no use for them
      // and the table is synced hourly, so this is a needless query otherwise.
      //
      // Which business account this ticket's number belongs to is what decides
      // the templates the agent may pick — not the installation — and asking
      // costs three round trips of its own. Chained inside the batch rather than
      // awaited above it: resolved first, it held the rest of the batch either
      // side of it, on the page the console spends most of its time on.
      conversation.channel === 'whatsapp' && answersHere
        ? accountIdForConversation(conversation.id).then((id) => listApprovedTemplates(id))
        : Promise.resolve([]),
      // Same reasoning: an agent who cannot start one has no picker to fill.
      canSideConversation ? listSideConversationRecipients() : Promise.resolve([]),
      // `seedTerms` returns nothing when all the customer has written is a
      // greeting, or nothing at all past our labels — a photo after words is
      // searched by those words — and `suggestForAgent` returns nothing for
      // fewer than two terms — so a ticket with nothing to go on costs no query
      // and renders no panel furniture, the same way the help centre's blocks
      // remove themselves.
      terms.length ? suggestForAgent(kbOrigin, agent.role, kbLocale, terms) : Promise.resolve([]),
      mayReply ? suggestionsLive() : Promise.resolve(false),
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
        suggestCanned={live && canned.length > 0}
        templates={templates}
        recipients={recipients}
        canSideConversation={canSideConversation}
        canModerateComments={canModerateComments}
        canEditContact={canEditContact}
        canClose={canClose}
        canSubcategorise={canSubcategorise}
        canSetCategory={canSetCategory}
        categories={toCategoryChoices(categories)}
        subcategoryOptions={subcategories}
        rootCauses={causes}
        purgePreview={purgePreview}
        purgeRefusal={purgeRefusal}
        currentAgentId={agent.id}
        canViewContact={canViewContact}
      />
      <FocusBeat conversationId={conversation.id} />
    </InboxShell>
  );
}
