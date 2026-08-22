import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { cannedResponses } from '@/db/schema';
import { Cell, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
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

  const rows = await db
    .select()
    .from(cannedResponses)
    .orderBy(asc(cannedResponses.folder), asc(cannedResponses.title));

  return (
    <>
      <PageHeader
        title="Canned responses"
        description="Reusable replies. Automations can send one of these as an auto-acknowledgement, which stops the first-response clock."
        actions={<NewCanned />}
      />

      <Table
        head={[
          'Title',
          'Folder',
          <>
            Used{' '}
            <InfoTip label="Used">
              Intended as how often the reply has been inserted, but nothing increments it yet — it
              reads zero for every response, including the ones the team sends daily.
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
