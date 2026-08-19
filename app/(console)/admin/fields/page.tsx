import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { ticketFields } from '@/db/schema';
import { Badge, Cell, PageHeader, Row, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { FieldEditor, NewField } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Custom ticket fields.
 *
 * The key is the important column: it is what a rule refers to as
 * `custom.<key>`, so it is set once at creation and never editable — renaming
 * it would break every stored automation and SLA condition silently.
 */
export default async function FieldsPage() {
  await requirePermission('admin.fields');

  const rows = await db
    .select()
    .from(ticketFields)
    .orderBy(asc(ticketFields.position), asc(ticketFields.label));

  return (
    <>
      <PageHeader
        title="Ticket fields"
        description="Extra information on a ticket. Rules refer to these as custom.key, which is why the key cannot change once it exists."
        actions={<NewField />}
      />

      <Table head={['Field', 'Key', 'Type', 'Required', '']}>
        {rows.map((field) => (
          <Row key={field.id}>
            <Cell>
              <FieldEditor field={field} />
            </Cell>
            <Cell>
              <code className="text-xs text-[var(--muted-foreground)]">custom.{field.key}</code>
            </Cell>
            <Cell className="text-xs">{field.type.replace('_', ' ')}</Cell>
            <Cell className="text-xs">
              {field.requiredOnCreate ? <Badge tone="warning">on create</Badge> : null}
              {field.requiredOnResolve ? <Badge tone="warning">to resolve</Badge> : null}
              {!field.requiredOnCreate && !field.requiredOnResolve ? (
                <span className="text-[var(--muted-foreground)]">optional</span>
              ) : null}
            </Cell>
            <Cell className="text-end">
              <FieldEditor field={field} deleteOnly />
            </Cell>
          </Row>
        ))}
      </Table>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted-foreground)]">
          No custom fields yet. Tickets still carry a subject, status, priority, group, assignee and
          tags.
        </p>
      ) : null}
    </>
  );
}
