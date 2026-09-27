import { Cell, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { listCannedResponses } from '@/lib/admin/settings';
import { requirePermission } from '@/lib/auth/guard';
import { CannedEditor, NewCanned } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Canned responses.
 *
 * Also what an automation sends: the `send_reply` action names one of these, so
 * an auto-acknowledgement is written and edited here rather than buried in a
 * rule's JSON.
 */
export default async function CannedPage() {
  await requirePermission('admin.fields');

  const rows = await listCannedResponses();

  return (
    <>
      <PageHeader
        title="Canned responses"
        description="Reusable replies. Agents can insert one while writing; automations can send one without satisfying the first-response SLA."
        actions={<NewCanned />}
      />

      <Table
        head={[
          'Title',
          'Folder',
          <>
            Used{' '}
            <InfoTip label="Used">
              How many replies went out carrying this response — counted when the reply is sent, so
              one an agent inserted and then thought better of does not score. Both paths count: an
              agent inserting it from the composer, and an automation sending it as an
              auto-acknowledgement. Counts start from the day this began being recorded, so a
              response the team has sent for months still starts at zero.
            </InfoTip>
          </>,
          '',
        ]}
      >
        {rows.map((response) => (
          <Row key={response.id}>
            <Cell>
              <CannedEditor response={response} />
            </Cell>
            <Cell className="text-xs text-[var(--muted-foreground)]">{response.folder ?? '—'}</Cell>
            <Cell className="text-xs text-[var(--muted-foreground)]">{response.usageCount}</Cell>
            <Cell className="text-end">
              <CannedEditor response={response} deleteOnly />
            </Cell>
          </Row>
        ))}
      </Table>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted-foreground)]">No canned responses yet.</p>
      ) : null}
    </>
  );
}
