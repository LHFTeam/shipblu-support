import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { can } from '@/lib/auth/permissions';
import { decodeSlugParam } from '@/lib/kb/slug';
import { formatDateTime, formatRelative } from '@/lib/format';
import { normaliseTrackingNumber } from '@/lib/shipments/format';
import { agentTrackingFor } from '@/lib/shipments/lookup';
import {
  conversationsForTrackingNumber,
  getShipmentByTrackingNumber,
} from '@/lib/shipments/queries';
import { humaniseStatus } from '@/lib/shipments/status';
import { scopeForAgent } from '@/lib/tickets/queries';
import { ConversationTable } from '../../conversation-table';
import { SyncBadge } from '../../page';
import { PartyField, RefreshShipmentButton } from './forms';

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

  /*
   * The stored platform payload, read for an agent rather than for the public
   * page — so it carries the recipient, the address and the COD amount that
   * `PublicTracking` structurally cannot. A plain read: the button below is how
   * the platform gets called, so that "checked N ago" stays true while an agent
   * is looking at it.
   */
  const detail = await agentTrackingFor(trackingNumber);

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

            <div className="mt-1">
              <RefreshShipmentButton
                trackingNumber={shipment.trackingNumber}
                lastSyncedAt={
                  shipment.lastSyncedAt ? `${formatRelative(shipment.lastSyncedAt)} ago` : null
                }
              />
            </div>
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

      {detail ? (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium">From the shipping platform</h2>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <h3 className="mb-2 text-xs font-medium opacity-60">Delivery</h3>
              <dl className="flex flex-col gap-1.5 text-xs">
                <Row label="Status" value={humaniseStatus(detail.status)} />
                <Row
                  label="As of"
                  value={detail.statusAt ? formatDateTime(detail.statusAt) : null}
                />
                {/* Calendar dates, printed as the strings they are. Passing one
                    through a Date would move it a day west of Greenwich. */}
                <Row label="Estimated" value={detail.estimatedDate} />
                <Row label="Preferred" value={detail.preferredDate} />
                <Row
                  label="Picked up"
                  value={detail.pickedUpAt ? formatDateTime(detail.pickedUpAt) : null}
                />
                <Row
                  label="Delivered"
                  value={detail.deliveredAt ? formatDateTime(detail.deliveredAt) : null}
                />
                <Row
                  label="Cash on delivery"
                  value={detail.codAmount === null ? null : `${detail.codAmount.toFixed(2)} EGP`}
                />
              </dl>
            </Card>

            <Card>
              <h3 className="mb-2 text-xs font-medium opacity-60">Parties</h3>
              <dl className="flex flex-col gap-1.5 text-xs">
                <Row label="Merchant" value={detail.merchantName} />
                <Row label="Merchant phone" value={detail.merchantPhone} />
                <Row label="Recipient" value={detail.recipientName} />
                <Row label="Recipient phone" value={detail.recipientPhone} />
                <Row label="Recipient email" value={detail.recipientEmail} />
                <Row
                  label="Address"
                  value={detail.addressLines.length ? detail.addressLines.join(', ') : null}
                />
                <Row
                  label="Zone"
                  value={[detail.zone, detail.city, detail.governorate].filter(Boolean).join(' · ')}
                />
              </dl>
              {/* These are the platform's own words about the parcel, not our
                  record of who the customer is. `shipper_contact_id` and
                  `recipient_contact_id` above are set by an agent on purpose —
                  the sync never guesses them from a phone number, for the reason
                  plans/shipment-customer-tracking.md §9 gives. */}
              <p className="mt-2 text-[11px] opacity-50">
                Read from the platform. Naming a contact as shipper or recipient is the pair of
                fields above, and is never inferred from these.
              </p>
            </Card>

            <Card>
              <h3 className="mb-2 text-xs font-medium opacity-60">
                History ({detail.events.length})
              </h3>
              {detail.events.length === 0 ? (
                <p className="text-xs opacity-50">No events recorded.</p>
              ) : (
                <ol className="flex flex-col gap-1.5 text-xs">
                  {/* Newest first. `mapDeliveryOrder` sorted these oldest-first
                      on the way in — the platform sends them unordered — so this
                      reverses a known order rather than establishing one. */}
                  {detail.events
                    .slice()
                    .reverse()
                    .map((event) => (
                      <li
                        key={`${event.status}-${event.at.toISOString()}`}
                        className="flex justify-between gap-3"
                      >
                        <span>{humaniseStatus(event.status)}</span>
                        <span className="shrink-0 tabular-nums opacity-60">
                          {formatDateTime(event.at)}
                        </span>
                      </li>
                    ))}
                </ol>
              )}
            </Card>
          </div>
        </section>
      ) : null}

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

/**
 * One label-and-value line, absent entirely when there is no value.
 *
 * A blank row next to "Recipient phone" reads as "this parcel has no phone
 * number on it", which is a different claim from "the platform did not send
 * one" — and an agent about to tell a customer we have no way to reach the
 * courier should not be given the first sentence when only the second is true.
 */
function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;

  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 opacity-60">{label}</dt>
      <dd className="text-end break-all">{value}</dd>
    </div>
  );
}
