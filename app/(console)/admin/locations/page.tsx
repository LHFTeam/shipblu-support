import { asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { locations } from '@/db/schema';
import { Badge, Cell, PageHeader, Row, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { LocationEditor, NewLocation } from './forms';

export const dynamic = 'force-dynamic';

/**
 * ShipBlu has sixteen locations, and until now this system had nowhere to say
 * so — a hub was whatever an agent typed into a ticket.
 *
 * The count is stated on the page for one reason: sixteen rows entered by hand
 * is exactly the job that gets left at fourteen, and a half-entered register is
 * worse than an empty one, because the two missing hubs look like locations that
 * do not exist.
 *
 * Sorted by code rather than by name. The code is what gets typed and quoted, so
 * it is the column somebody scans down looking for the row they mean.
 */
const EXPECTED = 16;

export default async function LocationsPage() {
  await requirePermission('admin.locations');

  const rows = await db
    .select({
      id: locations.id,
      name: locations.name,
      code: locations.code,
      email: locations.email,
      isActive: locations.isActive,
    })
    .from(locations)
    .orderBy(asc(locations.code));

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
          ? `None entered yet. There are ${EXPECTED} of them.`
          : rows.length < EXPECTED
            ? `${rows.length} of ${EXPECTED} entered — ${EXPECTED - rows.length} still missing.`
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
          Nothing routes on a location yet — no agent carries one and no ticket is attributed to
          one. This is the register they will point at, so the codes here should be the ones the
          operations team already uses out loud.
        </p>
      ) : (
        <p className="mt-3 text-xs text-[var(--muted-foreground)]">
          A location that has closed is marked not operating rather than deleted, so its code still
          reads in the tickets that mention it. Deleting is for one entered by mistake.
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
