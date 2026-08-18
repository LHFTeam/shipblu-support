import Link from 'next/link';
import { requirePermission } from '@/lib/auth/guard';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('admin.agents');

  return (
    <div className="mx-auto flex h-full max-w-4xl gap-8 overflow-y-auto p-6">
      <nav className="flex w-40 shrink-0 flex-col gap-1 text-sm">
        <Link href="/admin/agents" className="rounded px-2 py-1.5 hover:bg-[var(--muted)]">
          Agents
        </Link>
        <Link href="/admin/channels" className="rounded px-2 py-1.5 hover:bg-[var(--muted)]">
          Channels &amp; groups
        </Link>
        <Link href="/admin/import" className="rounded px-2 py-1.5 hover:bg-[var(--muted)]">
          Freshdesk import
        </Link>
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
