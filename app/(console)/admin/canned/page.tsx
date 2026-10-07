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
              Replies agents sent with this response inserted from the composer, counted when the
              reply is sent — a reply the channel later fails to deliver still counts. One inserted
              and then cleared from the box does not score; one inserted and then reworded does.
              When two go into one reply, only the last counts. An automation rule sending it is not
              counted at all.
              <br />
              <br />
              <b>Arabic</b> and <b>English</b> split the same replies by the language of the version
              inserted. A use whose language was not recorded — one from before the split, or sent
              from a console tab opened before it — counts in Used alone, so the two can add up to
              less.
            </InfoTip>
          </>,
          'Arabic',
          'English',
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
            <Cell className="text-xs text-[var(--muted-foreground)]">{response.usageCountAr}</Cell>
            <Cell className="text-xs text-[var(--muted-foreground)]">{response.usageCountEn}</Cell>
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
