import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { listInternalRecipients } from '@/lib/side-conversations/queries';
import { NewRecipient, RecipientEditor } from './forms';

export const dynamic = 'force-dynamic';

/**
 * The half of the side conversation picker that is not a place.
 *
 * Hubs and warehouses are **not** here. They are `locations` rows, entered at
 * `/admin/locations`, and the picker reads both registers into one list. Keeping
 * them apart means a hub's shared mailbox has exactly one screen that owns it —
 * two screens with nothing keeping them in step is the failure `locations` was
 * entered to prevent.
 *
 * What is left is everything a location cannot describe: Finance, a courier
 * partner, a customs broker.
 *
 * `admin.channels` rather than a permission of its own: this is the same
 * question that screen answers — where does mail go — asked about the inside of
 * the company instead of the outside.
 */
export default async function RecipientsPage() {
  await requirePermission('admin.channels');

  const recipients = await listInternalRecipients();

  return (
    <>
      <PageHeader
        title="Internal recipients"
        description="Teams and vendors an agent can start a side conversation with — Finance, a courier partner. Hubs and warehouses come from Locations instead, and the picker shows both. A side conversation hangs off a ticket, and the customer never sees it."
        actions={<NewRecipient />}
      />

      {recipients.length === 0 ? (
        <EmptyState
          title="No teams or vendors yet"
          hint="Only needed for parties that are not places — Finance, a courier partner. If you are looking for the hubs, they live under Locations and already appear in the picker."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {recipients.map((recipient) => (
            <Card key={recipient.id}>
              <RecipientEditor recipient={recipient} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
