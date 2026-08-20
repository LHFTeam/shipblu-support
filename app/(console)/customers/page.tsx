import Link from 'next/link';
import { Badge, Card, Cell, EmptyState, PageHeader, Row, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { searchCustomers } from '@/lib/shipments/queries';
import { CustomerSearch } from './search';

export const dynamic = 'force-dynamic';

/**
 * One search box over people, accounts and parcels.
 *
 * Three short tables rather than one merged list: an agent looking for a
 * customer and an agent looking for a tracking number want different things
 * back, and a single ranked list would bury one under the other.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission('contact.view');

  const params = await searchParams;
  const raw = params.q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';

  const results = q ? await searchCustomers(q) : { contacts: [], accounts: [], shipments: [] };

  const found = results.contacts.length + results.accounts.length + results.shipments.length;

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title="Customers"
        description="People, shipping accounts and shipments. Search by name, email, phone, SBID or tracking number."
      />

      <div className="mb-5 max-w-md">
        <CustomerSearch initial={q} />
      </div>

      {!q ? (
        <Card padded={false}>
          <EmptyState
            title="Search for a customer"
            hint="A name, an email address, a phone number, an SBID or a tracking number."
          />
        </Card>
      ) : found === 0 ? (
        <Card padded={false}>
          <EmptyState
            title="Nothing found"
            hint={`No customer, account or shipment matches “${q}”.`}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {results.contacts.length > 0 ? (
            <section>
              <h2 className="mb-2 text-sm font-medium">People</h2>
              <Table head={['Name', 'Email', 'Phone', 'Roles']}>
                {results.contacts.map((contact) => (
                  <Row key={contact.id}>
                    <Cell>
                      <Link
                        href={`/customers/${contact.id}`}
                        className="font-medium hover:underline"
                      >
                        {contact.name ?? 'Unnamed'}
                      </Link>
                    </Cell>
                    <Cell className="text-xs">{contact.email ?? '—'}</Cell>
                    <Cell className="text-xs">{contact.phone ?? '—'}</Cell>
                    <Cell>
                      <div className="flex gap-1">
                        {contact.isShipper ? <Badge tone="brand">Shipper</Badge> : null}
                        {contact.isRecipient ? <Badge>Recipient</Badge> : null}
                        {!contact.isShipper && !contact.isRecipient ? (
                          <span className="text-xs opacity-50">—</span>
                        ) : null}
                      </div>
                    </Cell>
                  </Row>
                ))}
              </Table>
            </section>
          ) : null}

          {results.accounts.length > 0 ? (
            <section>
              <h2 className="mb-2 text-sm font-medium">Shipping accounts</h2>
              <Table head={['SBID', 'Name', 'Synced']}>
                {results.accounts.map((account) => (
                  <Row key={account.id}>
                    <Cell>
                      <Link
                        href={`/customers/accounts/${encodeURIComponent(account.sbid)}`}
                        className="font-medium hover:underline"
                      >
                        {account.sbid}
                      </Link>
                    </Cell>
                    <Cell className="text-xs">{account.name ?? '—'}</Cell>
                    <Cell>
                      <SyncBadge state={account.syncState} />
                    </Cell>
                  </Row>
                ))}
              </Table>
            </section>
          ) : null}

          {results.shipments.length > 0 ? (
            <section>
              <h2 className="mb-2 text-sm font-medium">Shipments</h2>
              <Table head={['Tracking number', 'Status', 'Synced']}>
                {results.shipments.map((shipment) => (
                  <Row key={shipment.id}>
                    <Cell>
                      <Link
                        href={`/customers/shipments/${encodeURIComponent(shipment.trackingNumber)}`}
                        className="font-medium hover:underline"
                      >
                        {shipment.trackingNumber}
                      </Link>
                    </Cell>
                    <Cell className="text-xs">{shipment.statusLabel ?? '—'}</Cell>
                    <Cell>
                      <SyncBadge state={shipment.syncState} />
                    </Cell>
                  </Row>
                ))}
              </Table>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Says which of the three things a row is, and it matters most for `stub`: that
 * row exists because a number appeared in a message, and nothing has confirmed
 * it is real.
 */
export function SyncBadge({ state }: { state: 'stub' | 'synced' | 'not_found' }) {
  if (state === 'synced') return <Badge tone="success">Synced</Badge>;
  if (state === 'not_found') return <Badge tone="danger">Not found</Badge>;
  return <Badge tone="warning">Not synced</Badge>;
}
