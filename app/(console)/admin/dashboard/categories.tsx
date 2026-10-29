import Link from 'next/link';
import { Cell, EmptyState, Row, Table } from '@/components/ui';
import { categoryLabel } from '@/lib/categories/choices';
import type { CategoryLoad as CategoryLoadRow } from '@/lib/reports/live';

import { Section } from './section';

/**
 * The channel table's twin, cut by ticket category: the same backlog, the same
 * two columns, so the two read as one queue seen twice.
 *
 * The hint is static on purpose. Saying whether Jev is on or a channel routes
 * would be another read on every twenty-second refresh, and what "No category"
 * means does not change with either. It has to be said, because a registry
 * newer than its tickets reads as every row at zero and the whole queue under
 * "No category", which is true and looks broken.
 */
export function CategoryLoad({ categories }: { categories: CategoryLoadRow[] }) {
  return (
    <Section
      title="Open work by category"
      hint="Live, across the same open backlog, by each ticket’s category as it stands now. No category means nothing has filed the ticket yet — no person, rule, form default or Jev — and, on a channel that routes by category, includes tickets still in their routing window."
    >
      {/* The registry's rows are always there, so an empty queue is a table of
          zeros rather than no rows: ask the counts, not the length. */}
      {categories.every((row) => row.open === 0) ? (
        <EmptyState title="Nothing open" hint="Every conversation has been resolved or closed." />
      ) : (
        <Table head={['Category', 'Open', 'Waiting on us']}>
          {categories.map((row) => (
            <Row key={row.categoryId ?? 'none'}>
              <Cell>
                {/* No inbox filter names "no category", so that row is not a
                    link: one to the unfiltered inbox would list every ticket. */}
                {row.categoryId === null ? (
                  'No category'
                ) : (
                  <Link
                    href={`/inbox?category=${row.categoryId}`}
                    className="text-(--color-text-link) hover:text-(--color-text-link-hover) hover:underline"
                  >
                    {categoryLabel(row.labelEn, row.isActive)}
                  </Link>
                )}
              </Cell>
              <Cell>{row.open.toLocaleString('en-GB')}</Cell>
              <Cell>{row.awaitingReply.toLocaleString('en-GB')}</Cell>
            </Row>
          ))}
        </Table>
      )}
    </Section>
  );
}
