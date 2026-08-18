import { requireAgent } from '@/lib/auth/guard';
import { listInbox, parseFilters } from '@/lib/tickets/queries';
import { InboxList } from './list';

/**
 * The two-pane inbox frame, rendered by both `/inbox` and `/inbox/[number]`.
 *
 * A layout would keep the list mounted across navigations, but Next does not
 * pass searchParams to layouts and the list is filter-driven, so the frame is a
 * shared component instead. Client-side navigation still makes moving between
 * tickets a soft transition.
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
  const { rows, hasMore } = await listInbox(agent, filters);

  return (
    <div className="flex h-full">
      <aside className="flex w-[24rem] shrink-0 flex-col border-r border-[var(--border)]">
        <InboxList rows={rows} hasMore={hasMore} filters={filters} activeNumber={activeNumber} />
      </aside>
      <section className="min-w-0 flex-1 overflow-hidden">{children}</section>
    </div>
  );
}
