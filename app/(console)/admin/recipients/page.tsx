import { Card, EmptyState, PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { listInternalRecipients } from '@/lib/side-conversations/queries';
import { NewRecipient, RecipientEditor } from './forms';

export const dynamic = 'force-dynamic';

/**
 * The internal parties an agent can open a side conversation with.
 *
 * Filled in once by an admin so that no agent ever types a hub's address from
 * memory. The whole point of the screen is a picker, and the picker is only
 * worth having if it is complete — a hub that is missing from this list is a hub
 * somebody will reach by typing, which is where a customer's details end up at
 * an address nobody meant.
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
        description="Who an agent can start a side conversation with: hubs, internal teams and vendors. A side conversation hangs off a ticket, and the customer never sees it."
        actions={<NewRecipient />}
      />

      {recipients.length === 0 ? (
        <EmptyState
          title="No recipients yet"
          hint="Add the hubs first. An agent chasing a late parcel needs the hub holding it to be one click away, and every hub that is missing here is one somebody will address by hand."
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
