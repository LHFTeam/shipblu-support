import { asc, desc, eq, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, invites } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { formatDateTime } from '@/lib/format';
import { AgentRow, InviteForm } from './forms';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const admin = await requirePermission('admin.agents');

  const [agentList, openInvites] = await Promise.all([
    db
      .select({
        id: agents.id,
        name: agents.name,
        email: agents.email,
        role: agents.role,
        isActive: agents.isActive,
        lastSeenAt: agents.lastSeenAt,
      })
      .from(agents)
      .orderBy(asc(agents.name)),

    db
      .select({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        expiresAt: invites.expiresAt,
      })
      .from(invites)
      .where(isNull(invites.acceptedAt))
      .orderBy(desc(invites.createdAt)),
  ]);

  void eq;

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h1 className="mb-3 text-lg font-semibold">Agents</h1>
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {agentList.map((agent) => (
            <AgentRow key={agent.id} agent={agent} isSelf={agent.id === admin.id} />
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Invite an agent</h2>
        <InviteForm />
      </section>

      {openInvites.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-medium opacity-70">Pending invites</h2>
          <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
            {openInvites.map((invite) => (
              <li key={invite.id} className="flex items-center gap-3 px-3 py-2">
                <span>{invite.email}</span>
                <span className="opacity-50">{invite.role}</span>
                <span className="ml-auto text-xs opacity-50">
                  expires {formatDateTime(invite.expiresAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
