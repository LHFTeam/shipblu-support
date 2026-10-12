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
      {/* A panel of its own, as the ticket's are: the frame paints only the
          canvas between them. */}
      <div className="flex h-full items-center justify-center bg-(--color-background-surface) md:rounded-(--console-panel-radius)">
        <EmptyState
          title="Select a ticket"
          hint="Pick a conversation from the list to get started."
        />
      </div>
    </InboxShell>
  );
}
