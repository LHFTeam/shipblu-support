import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { decodeSlugParam } from '@/lib/kb/slug';
import { normaliseSbid } from '@/lib/shipments/format';
import {
  contactsForSbid,
  conversationsForSbid,
  getShippingAccountBySbid,
  shipmentsForSbid,
} from '@/lib/shipments/queries';
import { scopeForAgent } from '@/lib/tickets/queries';
import { ConversationTable } from '../../conversation-table';
import { SyncBadge } from '../../page';

export const dynamic = 'force-dynamic';

/**
 * One shipping account.
 *
 * `decodeSlugParam` first: Next hands dynamic route params over still
 * percent-encoded, and this one is matched against stored text. Skipping it is
 * what made every Arabic knowledge base slug 404 while the pages above them,
 * which take no parameter, looked perfectly healthy.
 */
export default async function ShippingAccountPage({
  params,
}: {
  params: Promise<{ sbid: string }>;
}) {
  const agent = await requirePermission('contact.view');
  const { sbid: raw } = await params;
  const sbid = normaliseSbid(decodeSlugParam(raw));

  const account = await getShippingAccountBySbid(sbid);
  if (!account) notFound();

  const [people, parcels, conversations] = await Promise.all([
    contactsForSbid(sbid),
    shipmentsForSbid(sbid),
    conversationsForSbid(sbid, scopeForAgent(agent)),
  ]);

  return (
    <div className="app-scroll h-full overflow-y-auto p-4 md:p-6">
      <PageHeader
        title={account.name ?? `SBID ${account.sbid}`}
        description={account.name ? `SBID ${account.sbid}` : undefined}
        actions={
          <Link href="/contacts" className="text-sm hover:underline">
            All contacts
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <h2 className="mb-2 text-sm font-medium">Account</h2>
          <div className="flex flex-col gap-2 text-xs">
            <SyncBadge state={account.syncState} />
            {account.syncState === 'stub' ? (
              <p className="text-[var(--muted-foreground)]">
                This account exists because its number appeared in a conversation. Nothing has
                confirmed it against the shipping platform yet.
              </p>
            ) : null}
            {account.companyName ? <p>Company: {account.companyName}</p> : null}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-medium">People who can speak for it</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {people.map((person) => (
              <li key={person.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/contacts/${person.id}`} className="font-medium hover:underline">
                  {person.name ?? person.email ?? person.phone ?? 'Unnamed'}
                </Link>
                <span className="text-xs opacity-60">{person.email ?? person.phone ?? ''}</span>
                {person.linkSource === 'platform' ? <Badge>platform</Badge> : null}
              </li>
            ))}
            {people.length === 0 ? (
              <li className="text-xs opacity-50">
                Nobody yet. Membership is only ever recorded by an agent or by a platform sync —
                quoting an account number in a chat does not make it yours.
              </li>
            ) : null}
          </ul>
        </Card>
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium">Recent shipments</h2>
        <Card>
          <ul className="flex flex-col gap-2 text-sm">
            {parcels.map((parcel) => (
              <li key={parcel.id} className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/contacts/shipments/${encodeURIComponent(parcel.trackingNumber)}`}
                  className="font-medium hover:underline"
                >
                  {parcel.trackingNumber}
                </Link>
                <SyncBadge state={parcel.syncState} />
                <span className="text-xs opacity-60">{parcel.statusLabel ?? ''}</span>
              </li>
            ))}
            {parcels.length === 0 ? (
              <li className="text-xs opacity-50">
                None. A shipment is only attributed to an account by a platform sync.
              </li>
            ) : null}
          </ul>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Conversations</h2>
        <p className="mb-2 text-xs text-[var(--muted-foreground)]">
          Tickets that name this account, and tickets opened by anyone who can speak for it.
        </p>
        <ConversationTable
          conversations={conversations}
          emptyTitle="No conversations"
          emptyHint="Nothing visible to you names this account or comes from one of its people."
        />
      </section>
    </div>
  );
}
