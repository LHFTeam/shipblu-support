import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { decodeSlugParam } from '@/lib/kb/slug';
import { normaliseTrackingNumber } from '@/lib/shipments/format';
import {
  conversationsForTrackingNumber,
  getShipmentByTrackingNumber,
} from '@/lib/shipments/queries';
import { scopeForAgent } from '@/lib/tickets/queries';
import { ConversationTable } from '../../conversation-table';
import { SyncBadge } from '../../page';
import { PartyField } from './forms';

export const dynamic = 'force-dynamic';

/**
 * One shipment.
 *
 * `decodeSlugParam` before normalising, for the reason recorded in
 * `lib/kb/slug.ts`: Next hands dynamic params over percent-encoded, and this one
 * is matched against stored text.
 */
export default async function ShipmentPage({ params }: { params: Promise<{ tracking: string }> }) {
  const agent = await requirePermission('contact.view');
  const { tracking: raw } = await params;
  const trackingNumber = normaliseTrackingNumber(decodeSlugParam(raw));

  const shipment = await getShipmentByTrackingNumber(trackingNumber);
  if (!shipment) notFound();

  const conversations = await conversationsForTrackingNumber(trackingNumber, scopeForAgent(agent));

  const editable = can(agent, 'contact.edit');

  return (
    <div className="p-4 md:p-6">
      <PageHeader
        title={shipment.trackingNumber}
        description={shipment.statusLabel ?? undefined}
        actions={
          <Link href="/contacts" className="text-sm hover:underline">
            All contacts
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <h2 className="mb-2 text-sm font-medium">Shipment</h2>
          <div className="flex flex-col gap-2 text-xs">
            <SyncBadge state={shipment.syncState} />
            {shipment.syncState === 'stub' ? (
              <p className="text-[var(--muted-foreground)]">
                Created from a number somebody wrote in a message. Nothing has confirmed this is a
                real shipment, which is why both ends are blank rather than empty.
              </p>
            ) : null}
            {shipment.syncState === 'not_found' ? (
              <p className="text-[var(--muted-foreground)]">
                The shipping platform does not recognise this number. It is most likely a typo, or
                something the detector picked up that was never a tracking number.
              </p>
            ) : null}
            {shipment.sbid ? (
              <p>
                Account:{' '}
                <Link
                  href={`/contacts/accounts/${encodeURIComponent(shipment.sbid)}`}
                  className="font-medium hover:underline"
                >
                  SBID {shipment.sbid}
                </Link>
              </p>
            ) : null}
          </div>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-medium">Shipper</h2>
          <PartyField
            trackingNumber={shipment.trackingNumber}
            party="shipper"
            current={shipment.shipper}
            editable={editable}
          />
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-medium">Recipient</h2>
          <PartyField
            trackingNumber={shipment.trackingNumber}
            party="recipient"
            current={shipment.recipient}
            editable={editable}
          />
        </Card>
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium">Conversations</h2>
        <ConversationTable
          conversations={conversations}
          emptyTitle="No conversations"
          emptyHint="Nothing visible to you is linked to this shipment."
        />
      </section>
    </div>
  );
}
