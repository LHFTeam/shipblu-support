import { Badge, Cell, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { listTicketStatuses } from '@/lib/admin/settings';
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

  const rows = await listTicketStatuses();

  return (
    <>
      <PageHeader
        title="Ticket statuses"
        description="What a ticket can be. The category drives SLA and reporting; the SLA clock switch decides whether time in this status counts against your targets."
        actions={<NewStatus />}
      />

      <Table
        head={[
          'Status',
          <>
            Category{' '}
            <InfoTip label="Category">
              The four states everything else reasons about. SLA and every report group by this and
              never by the status&rsquo;s name, so one filed under the wrong category miscounts
              quietly: <b>open</b> and <b>pending</b> are the live backlog every figure on the
              dashboard counts, and <b>resolved</b> and <b>closed</b> are outside it.
            </InfoTip>
          </>,
          <>
            SLA clock{' '}
            <InfoTip label="SLA clock">
              Whether time in this status counts against your targets. Paused is for waiting on
              someone else — that time is added back to the due date when the ticket moves on.
            </InfoTip>
          </>,
          <>
            Customer sees{' '}
            <InfoTip label="Customer sees">
              What the portal shows. Agents name statuses for themselves — &ldquo;Waiting on
              ops&rdquo;, &ldquo;Escalated tier 2&rdquo; — so a customer is never shown the
              status&rsquo;s own name: they see the label set here, and with none set, a plain word
              for the category in their own language.
            </InfoTip>
          </>,
          '',
        ]}
      >
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
              {status.visibleToCustomer ? (
                (status.customerLabel ?? <span className="italic">the category word</span>)
              ) : (
                <span>hidden</span>
              )}
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
