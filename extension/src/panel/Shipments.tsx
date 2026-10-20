import { useState, type ReactNode } from 'react';
import { ReturnIcon } from '@/components/icons';
import { RelativeTime } from '@/components/relative-time';
import { StatusBadge, Stepper } from '@/components/shipment-status';
import { Badge, Button, EmptyState, ErrorText, Notice } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { listShipments, shipmentTracking, type Shipment } from './api';
import { usePolled } from './hooks';

/**
 * The parcels on the chat's ticket, drawn as the console's sidebar draws them:
 * the server sends `shipmentCard()`'s words, tone, bar and due date, so this
 * file decides how a card looks and never what it says.
 */
export function ShipmentsTab({ ticketId }: { ticketId: string }) {
  const parcels = usePolled(`shipments:${ticketId}`, () => listShipments(ticketId));

  if (parcels.loading) {
    return <p className="text-sm text-(--color-text-secondary)">Loading shipments…</p>;
  }
  if (!parcels.data) return <ErrorText>{parcels.error?.message ?? null}</ErrorText>;
  if (parcels.data.length === 0) {
    return (
      <EmptyState
        title="No shipments on this ticket"
        hint="A tracking number the customer sends is linked automatically, and its status fetched."
      />
    );
  }

  return (
    <>
      {parcels.error ? <ErrorText inline>{parcels.error.message}</ErrorText> : null}
      <ul className="flex flex-col gap-2">
        {parcels.data.map((shipment) => (
          <ShipmentCard key={shipment.shipmentId} ticketId={ticketId} shipment={shipment} />
        ))}
      </ul>
    </>
  );
}

function ShipmentCard({ ticketId, shipment }: { ticketId: string; shipment: Shipment }) {
  const [open, setOpen] = useState(false);
  const { card } = shipment;

  return (
    <li className="grid gap-2.5 rounded-lg border border-(--color-border-subtle) bg-(--color-background-surface) p-3">
      {/* Wraps rather than squeezing: "Not a shipment on the platform" beside a
          thirteen-digit number is wider than the panel. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span dir="ltr" className="font-mono text-xs break-all select-all">
          {shipment.trackingNumber}
        </span>
        <span className="ms-auto shrink-0">
          <StatusBadge size="sm" label={card.label} tone={card.tone} />
        </span>
      </div>

      {card.bar ? (
        <Stepper
          size="sm"
          tone={card.bar.tone}
          labels={card.bar.labels}
          current={card.bar.step}
          doneLabel="done"
        />
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <Property label="Updated">
          {shipment.statusAt ? (
            <RelativeTime at={shipment.statusAt}>{(relative) => relative}</RelativeTime>
          ) : null}
        </Property>
        <Property label="Due" ltr>
          {card.due}
        </Property>
        <Property label="Account" ltr>
          {shipment.sbid ? `SBID ${shipment.sbid}` : null}
        </Property>
      </dl>

      <div className="flex flex-wrap items-center gap-1.5 text-xs text-(--color-text-secondary)">
        <span className="me-auto">{shipment.requesterRole}</span>
        {shipment.returning ? (
          <Badge icon={<ReturnIcon size={12} className="shrink-0" />}>Returning</Badge>
        ) : null}
        {shipment.linkSource === 'detected' ? <Badge tone="automated">Auto</Badge> : null}
      </div>

      <Button variant="secondary" size="sm" onClick={() => setOpen((value) => !value)}>
        {open ? 'Hide tracking' : 'Tracking details'}
      </Button>
      {open ? <TrackingDetail ticketId={ticketId} shipmentId={shipment.shipmentId} /> : null}
    </li>
  );
}

function Property({
  label,
  ltr = false,
  children,
}: {
  label: string;
  ltr?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-(--color-text-secondary)">{label}</dt>
      <dd dir={ltr ? 'ltr' : undefined} className="text-start">
        {children ?? <span className="text-(--color-text-tertiary)">—</span>}
      </dd>
    </>
  );
}

/**
 * The platform's full record: history, recipient, address and the money.
 * Behind `contact.view` on the server, as the console's shipment page is.
 */
function TrackingDetail({ ticketId, shipmentId }: { ticketId: string; shipmentId: string }) {
  // Five minutes: the parcel's own status above refreshes every thirty
  // seconds, and this is the long read an agent opened on purpose.
  const detail = usePolled(
    `tracking:${ticketId}:${shipmentId}`,
    () => shipmentTracking(ticketId, shipmentId),
    5 * 60_000,
  );

  if (detail.loading) {
    return <p className="text-xs text-(--color-text-secondary)">Loading tracking…</p>;
  }
  if (detail.error?.status === 403) {
    return <Notice tone="info">{detail.error.message}</Notice>;
  }
  if (!detail.data) return <ErrorText inline>{detail.error?.message ?? null}</ErrorText>;

  const { tracking, view } = detail.data;
  const zone = [tracking.zone, tracking.city, tracking.governorate].filter(Boolean).join(' · ');

  return (
    <div className="grid gap-3 border-t border-(--color-border-subtle) pt-2.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <Property label="Status">{view.statusLabel}</Property>
        {view.platformSays ? <Property label="Platform says">{view.platformSays}</Property> : null}
        {/* Calendar dates, printed as the strings they are: through a Date one
            would move a day west of Greenwich. No estimate on a return, which
            has no delivery to estimate. */}
        {view.returning ? null : (
          <Property label="Estimated" ltr>
            {tracking.estimatedDate}
          </Property>
        )}
        {tracking.bookedEstimatedDate && tracking.bookedEstimatedDate !== tracking.estimatedDate ? (
          <Property label="Booked for" ltr>
            {tracking.bookedEstimatedDate}
          </Property>
        ) : null}
        <Property label="Cash on delivery" ltr>
          {tracking.codAmount === null ? null : `${tracking.codAmount.toFixed(2)} EGP`}
        </Property>
        <Property label="Recipient">{tracking.recipientName}</Property>
        <Property label="Phone" ltr>
          {tracking.recipientPhone}
        </Property>
        <Property label="Address">
          {tracking.addressLines.length ? (
            <span dir="auto">{tracking.addressLines.join(', ')}</span>
          ) : null}
        </Property>
        <Property label="Zone">{zone || null}</Property>
        <Property label="Merchant">{tracking.merchantName}</Property>
      </dl>

      <div>
        <h3 className="mb-1 text-xs font-semibold text-(--color-text-secondary)">
          History ({view.events.length})
        </h3>
        {view.events.length === 0 ? (
          <p className="text-xs text-(--color-text-tertiary)">No events recorded.</p>
        ) : (
          <ol className="flex flex-col gap-1 text-xs">
            {view.events.map((event) => (
              <li key={`${event.label}-${event.at}`} className="flex justify-between gap-3">
                <span>
                  {event.label}
                  {event.onReturnLeg ? (
                    <span className="ms-1.5 text-(--color-text-tertiary)">· return</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-(--color-text-tertiary) tabular-nums">
                  {formatDateTime(event.at)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
