import {
  knowledgeBaseCounts,
  locationCounts,
  recentRuns,
  shipmentCounts,
} from '@/lib/admin/import-status';
import { requirePermission } from '@/lib/auth/guard';
import { ImportForm } from './form';
import { LocationBackfillForm } from './location-backfill';
import { ShipmentBackfillForm } from './shipment-backfill';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requirePermission('admin.agents');

  const [runs, counts, backfillRuns, shipmentRow, locationRuns, locationRow] = await Promise.all([
    recentRuns('import_freshdesk_kb'),
    knowledgeBaseCounts(),
    recentRuns('backfill_shipment_links'),
    shipmentCounts(),
    recentRuns('backfill_message_locations'),
    locationCounts(),
  ]);

  return (
    <div className="flex flex-col gap-10">
      <ImportForm runs={runs} counts={counts} />
      <ShipmentBackfillForm runs={backfillRuns} counts={shipmentRow} />
      <LocationBackfillForm runs={locationRuns} counts={locationRow} />
    </div>
  );
}
