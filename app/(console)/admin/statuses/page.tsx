import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketStatuses } from '@/db/schema';
import { Badge, Cell, PageHeader, Row, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { NewStatus, StatusEditor } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Ticket statuses.
 *
 * The two switches that matter are not cosmetic. `category` is what SLA and
 * reporting key off, so a status in the wrong one silently miscounts every
 * report. `stopsSlaClock` is what makes "waiting on the customer" not count
 * against the team — the page says so rather than leaving an admin to find out
 * from a breach report.
 */
export default async function StatusesPage() {
  await requirePermission('admin.fields');

  const rows = await db
    .select()
    .from(ticketStatuses)
    .orderBy(asc(ticketStatuses.position), asc(ticketStatuses.name));

  return (
    <>
      <PageHeader
        title="Ticket statuses"
        description="What a ticket can be. The category drives SLA and reporting; the SLA clock switch decides whether time in this status counts against your targets."
        actions={<NewStatus />}
      />

      <Table head={['Status', 'Category', 'SLA clock', 'Customer sees', '']}>
        {rows.map((status) => (
          <Row key={status.id}>
            <Cell>
              <StatusEditor status={status} />
            </Cell>
            <Cell>
              <Badge tone={status.category}>{status.category}</Badge>
            </Cell>
            <Cell>
              {status.stopsSlaClock ? (
                <span className="text-xs text-[var(--muted-foreground)]">paused</span>
              ) : (
                <span className="text-xs">running</span>
              )}
            </Cell>
            <Cell className="text-xs text-[var(--muted-foreground)]">
              {status.visibleToCustomer ? (status.customerLabel ?? status.name) : 'hidden'}
            </Cell>
            <Cell className="text-end">
              <StatusEditor status={status} deleteOnly />
            </Cell>
          </Row>
        ))}
      </Table>
    </>
  );
}
