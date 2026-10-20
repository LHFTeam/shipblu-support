import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { channelInfo } from '@/components/channel';
import { LiveUpdates } from '@/components/live-updates';
import { ViewsPanel, type ViewsPanelSection } from '@/components/views-panel';
import { inboxCounts, listInbox } from '@/lib/tickets/inbox';
import { parseFilters } from '@/lib/tickets/inbox-filters';
import { assignmentScope, inboxGroupsFor } from '@/lib/tickets/visibility';
import { activeViewId, inboxViews, seesGroupQueues, viewHref } from '@/lib/tickets/inbox-views';
import { InboxList, KnowledgeBaseLink } from './list';

/**
 * The inbox frame, rendered by both `/inbox` and `/inbox/[number]`.
 *
 * A layout would keep the list mounted across navigations, but Next does not
 * pass searchParams to layouts and the list is filter-driven, so the frame is a
 * shared component instead. Client-side navigation still makes moving between
 * tickets a soft transition.
 *
 * From `md` the frame is white panels on the console's grey, 8px apart and
 * rounded, with no rules between them: the views from 1366px — below that the
 * same views are a picker in the list's header — then the list, then whatever
 * the page puts in the last column, which paints its own panels. The canvas
 * stops here; every other console page is full-bleed under the header.
 *
 * On a phone the panes become one screen at a time — list, then ticket —
 * because a list beside a conversation on a 390px screen leaves room for
 * neither, and the panels go full-bleed with no canvas around them. Which pane
 * shows is decided by whether a ticket is open, so the back link out of a ticket
 * is just a link to the inbox.
 */
export async function InboxShell({
  searchParams,
  activeNumber,
  activeConversationId,
  children,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  activeNumber?: number;
  activeConversationId?: string;
  children: React.ReactNode;
}) {
  const agent = await requireAgent();
  const filters = parseFilters(searchParams);
  // The counts are the ones the console layout already asked for on this
  // request; `inboxCounts` memoises them, so the views cost no second query.
  // The groups are one small read, for the group views' names.
  const [{ rows, nextCursor }, counts, groups] = await Promise.all([
    listInbox(agent, filters),
    inboxCounts(agent),
    inboxGroupsFor(agent),
  ]);

  const viewingTicket = activeNumber !== undefined;
  // From the scope `listInbox` and `inboxCounts` are drawn from, so a view is
  // offered for exactly what the lists can hold.
  const scope = assignmentScope(agent);
  const canViewAll = !scope;
  const canViewGroups = scope?.includeGroups ?? false;
  const canSeeBot = can(agent, 'ticket.view.bot');
  const canSeeRatings = can(agent, 'report.view');

  // A view keeps the open ticket open, as the Status and Channel selects do.
  const base = viewingTicket ? `/inbox/${activeNumber}` : '/inbox';
  const views = inboxViews({ canSeeBot, canViewAll, canViewGroups, groups, canSeeRatings });
  const activeView = activeViewId(views, filters, { canViewAll, canViewGroups, groups });
  const sections: ViewsPanelSection[] = views.map((section) => ({
    title: section.title,
    items: section.items.map((view) => ({
      id: view.id,
      label: view.label ?? channelInfo(view.channel ?? '').label,
      href: viewHref(base, view.filters, filters.q),
      icon: view.icon,
      channel: view.channel,
      count: view.count ? counts[view.count] : undefined,
      attention: view.attention,
    })),
  }));

  return (
    <div className="flex h-full md:gap-(--console-gap) md:bg-(--color-background-console) md:px-(--console-gap) md:pb-(--console-gap)">
      <LiveUpdates channel={filters.channel} conversationId={activeConversationId} />

      <div className="app-scroll hidden w-(--views-width) shrink-0 overflow-y-auto rounded-(--console-panel-radius) bg-(--color-background-surface) min-[1366px]:block">
        <ViewsPanel
          title="Inbox"
          sections={sections}
          active={activeView}
          footer={<KnowledgeBaseLink className="mx-0.5" />}
        />
      </div>

      <aside
        className={`w-full shrink-0 flex-col bg-(--color-background-surface) md:flex md:w-(--list-width) md:overflow-hidden md:rounded-(--console-panel-radius) ${
          viewingTicket ? 'hidden md:flex' : 'flex'
        }`}
      >
        <InboxList
          rows={rows}
          nextCursor={nextCursor}
          filters={filters}
          activeNumber={activeNumber}
          views={sections}
          activeView={activeView}
          canSeeBot={canSeeBot}
          canSeeRatings={canSeeRatings}
          canViewAll={canViewAll}
          seesGroupQueues={seesGroupQueues(canViewGroups, groups)}
          canCreate={can(agent, 'ticket.create')}
          canViewContacts={can(agent, 'contact.view')}
        />
      </aside>

      <section
        className={`min-w-0 flex-1 overflow-hidden ${viewingTicket ? 'block' : 'hidden md:block'}`}
      >
        {children}
      </section>
    </div>
  );
}
