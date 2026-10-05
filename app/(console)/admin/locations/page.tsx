import { Badge, Cell, PageHeader, Row, Table } from '@/components/ui';
import { listLocations } from '@/lib/admin/settings';
import { requirePermission } from '@/lib/auth/guard';
import { LocationEditor, NewLocation } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Where ShipBlu's people work. Before this register a hub was whatever an agent
 * typed into a ticket. No number of locations is expected: the register holds
 * whatever an admin has entered.
 *
 * Sorted by code rather than by name. The code is what gets typed and quoted, so
 * it is the column somebody scans down looking for the row they mean.
 */
export default async function LocationsPage() {
  await requirePermission('admin.locations');

  const rows = await listLocations();

  const operating = rows.filter((row) => row.isActive).length;

  return (
    <>
      <PageHeader
        title="Locations"
        description="Where ShipBlu's people work: a name, the code that gets typed, and the shared mailbox that reaches whoever is there."
        actions={<NewLocation />}
      />

      <p className="mb-4 text-xs text-[var(--muted-foreground)]">
        {rows.length === 0
          ? 'None entered yet.'
          : `${rows.length} entered, ${operating} operating.`}
      </p>

      <Table head={['Code', 'Location', 'Email', '']}>
        {rows.map((location) => (
          <Row key={location.id}>
            <Cell>
              <span className="font-mono text-xs">{location.code}</span>
            </Cell>
            <Cell>
              <LocationEditor location={location} />
            </Cell>
            <Cell className="text-xs text-[var(--muted-foreground)]">
              <a href={`mailto:${location.email}`} className="hover:underline">
                {location.email}
              </a>
            </Cell>
            <Cell className="text-end">
              <LocationEditor location={location} deleteOnly />
            </Cell>
          </Row>
        ))}
      </Table>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted-foreground)]">
          A location is already how an agent reaches a hub: every row here appears in the
          side-conversation picker on a ticket, under its code, and the thread records which
          location it went to. Nothing <em>routes</em> on one yet — no agent carries a location and
          no ticket is attributed to one — so this is a register of who can be written to, not of
          who work is assigned to. The codes should be the ones the operations team already uses out
          loud.
        </p>
      ) : (
        <p className="mt-3 text-xs text-[var(--muted-foreground)]">
          A location that has closed is marked not operating rather than deleted, so its code still
          reads in the tickets that mention it. Deleting is for one entered by mistake — one a side
          conversation has already gone to is marked not operating instead, so the thread still
          names it.
        </p>
      )}

      {rows.some((row) => !row.isActive) ? (
        <p className="mt-3 flex items-center gap-2 text-xs">
          <Badge tone="neutral">closed</Badge>
          <span className="text-[var(--muted-foreground)]">
            {rows.length - operating} location(s) no longer operating.
          </span>
        </p>
      ) : null}
    </>
  );
}
