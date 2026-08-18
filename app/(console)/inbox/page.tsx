import { EmptyState } from '@/components/ui';
import { InboxShell } from './shell';

export const dynamic = 'force-dynamic';

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  return (
    <InboxShell searchParams={params}>
      <EmptyState
        title="Select a ticket"
        hint="Pick a conversation from the list to get started."
      />
    </InboxShell>
  );
}
