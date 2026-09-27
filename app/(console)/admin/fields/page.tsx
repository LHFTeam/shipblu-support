import { Badge, Cell, PageHeader, Row, Table } from '@/components/ui';
import { InfoTip } from '@/components/tooltip';
import { listTicketFields } from '@/lib/admin/settings';
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

  const rows = await listTicketFields();

  return (
    <>
      <PageHeader
        title="Ticket fields"
        description="Extra information on a ticket. Rules refer to these as custom.key, which is why the key cannot change once it exists."
        actions={<NewField />}
      />

      <Table
        head={[
          'Field',
          <>
            Key{' '}
            <InfoTip label="Key">
              How this field is named everywhere it is not shown to a person — an automation or SLA
              condition reads it as <code>custom.the_key</code>, and every answer a ticket gives it
              is filed under it. Fixed once the field exists, and the reason grew with the answers:
              renaming it would leave every stored rule pointing at nothing <em>and</em> strand the
              value on every ticket that ever filled it in, with nothing reporting an error.
            </InfoTip>
          </>,
          'Type',
          <>
            Required{' '}
            <InfoTip label="Required">
              <b>On create</b> refuses a ticket opened from the customer portal until the field is
              answered — and only applies to fields a customer can actually see and edit, since a
              question they are never shown is not one they can answer. <b>To resolve</b> refuses an
              agent&rsquo;s move to a resolved status, and the reply-and-resolve button with it.
              Neither stops an automation: a rule cannot fill a field in, so enforcing it there
              would wedge tickets nobody was asked to clear.
            </InfoTip>
          </>,
          '',
        ]}
      >
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
