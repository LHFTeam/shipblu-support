import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { conversationsForContact, getContact } from '@/lib/contacts/queries';
import { shipmentsForContact, shippingAccountsForContact } from '@/lib/shipments/queries';
import { ConversationTable } from '../conversation-table';
import { SyncBadge } from '../page';
import { AccountLinks, RoleToggles } from './forms';

export const dynamic = 'force-dynamic';

/**
 * One customer.
 *
 * The page the console has never had. Its job here is to answer two questions
 * an agent could not previously ask: what else has this person written in about,
 * and which shipping accounts can they speak for.
 */
export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const agent = await requirePermission('contact.view');
  const { id } = await params;

  const contact = await getContact(id);
  if (!contact) notFound();

  const [accounts, parcels, conversations] = await Promise.all([
    shippingAccountsForContact(contact.id),
    shipmentsForContact(contact.id),
    conversationsForContact(agent, contact.id),
  ]);

  const editable = can(agent, 'contact.edit');

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={contact.name ?? contact.email ?? contact.phone ?? 'Unnamed customer'}
        description={[contact.email, contact.phone].filter(Boolean).join(' · ') || undefined}
        actions={
          <Link href="/customers" className="text-sm hover:underline">
            All customers
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <h2 className="mb-2 text-sm font-medium">Roles</h2>
          {editable ? (
            <RoleToggles
              contactId={contact.id}
              isShipper={contact.isShipper}
              isRecipient={contact.isRecipient}
            />
          ) : (
            <div className="flex gap-1">
              {contact.isShipper ? <Badge tone="brand">Shipper</Badge> : null}
              {contact.isRecipient ? <Badge>Recipient</Badge> : null}
              {!contact.isShipper && !contact.isRecipient ? (
                <span className="text-xs opacity-50">Neither, so far.</span>
              ) : null}
            </div>
          )}
          <p className="mt-3 text-xs text-[var(--muted-foreground)]">
            Set automatically when we learn one — holding a shipping account makes someone a
            shipper, being named on a parcel makes them a recipient — and never unset automatically,
            so a designation made here survives the next sync.
          </p>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-medium">Reachable on</h2>
          <ul className="flex flex-col gap-1 text-xs">
            {contact.identities.map((identity) => (
              <li key={identity.id} className="flex items-center gap-2">
                <span className="w-20 shrink-0 opacity-60">{identity.channel}</span>
                <span className="min-w-0 break-all">{identity.identifier}</span>
                {identity.isVerified ? <Badge tone="success">verified</Badge> : null}
              </li>
            ))}
            {contact.identities.length === 0 ? <li className="opacity-50">None.</li> : null}
          </ul>
          {contact.companyName ? (
            <p className="mt-3 text-xs text-[var(--muted-foreground)]">
              Company: {contact.companyName}
            </p>
          ) : null}
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-medium">Shipping accounts</h2>
          <AccountLinks contactId={contact.id} accounts={accounts} editable={editable} />
        </Card>
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium">Shipments</h2>
        {parcels.length === 0 ? (
          <Card>
            <p className="text-xs text-[var(--muted-foreground)]">
              This person is not named on any shipment yet. Nothing names them until a platform sync
              or an agent says which end of a parcel they are on.
            </p>
          </Card>
        ) : (
          <Card>
            <ul className="flex flex-col gap-2 text-sm">
              {parcels.map((parcel) => (
                <li key={parcel.id} className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/customers/shipments/${encodeURIComponent(parcel.trackingNumber)}`}
                    className="font-medium hover:underline"
                  >
                    {parcel.trackingNumber}
                  </Link>
                  {parcel.isShipper ? <Badge tone="brand">shipper</Badge> : null}
                  {parcel.isRecipient ? <Badge>recipient</Badge> : null}
                  <SyncBadge state={parcel.syncState} />
                  <span className="text-xs opacity-60">{parcel.statusLabel ?? ''}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Conversations</h2>
        <ConversationTable
          conversations={conversations}
          emptyTitle="No conversations"
          emptyHint="Nothing this customer has written in about is visible to you."
        />
      </section>
    </div>
  );
}
