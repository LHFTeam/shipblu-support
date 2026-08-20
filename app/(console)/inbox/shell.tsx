import { requireAgent } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { listInbox, parseFilters } from '@/lib/tickets/queries';
import { InboxList } from './list';

/**
 * The inbox frame, rendered by both `/inbox` and `/inbox/[number]`.
 *
 * A layout would keep the list mounted across navigations, but Next does not
 * pass searchParams to layouts and the list is filter-driven, so the frame is a
 * shared component instead. Client-side navigation still makes moving between
 * tickets a soft transition.
 *
 * On a phone the two panes become one screen at a time — list, then ticket —
 * because 24rem of list beside a conversation on a 390px screen leaves room for
 * neither. Which pane shows is decided by whether a ticket is open, so the back
 * link out of a ticket is just a link to the inbox.
 */
export async function InboxShell({
  searchParams,
  activeNumber,
  children,
}: {
  searchParams: Record<string, string | string[] | undefined>;
  activeNumber?: number;
  children: React.ReactNode;
}) {
  const agent = await requireAgent();
  const filters = parseFilters(searchParams);
  const { rows, nextCursor } = await listInbox(agent, filters);

  const viewingTicket = activeNumber !== undefined;

  return (
    <div className="flex h-full">
      <aside
        className={`w-full shrink-0 flex-col border-e border-[var(--border)] md:flex md:w-[22rem] lg:w-[24rem] ${
          viewingTicket ? 'hidden md:flex' : 'flex'
        }`}
      >
        <InboxList
          rows={rows}
          nextCursor={nextCursor}
          filters={filters}
          activeNumber={activeNumber}
          canSeeBot={can(agent, 'ticket.view.bot')}
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
