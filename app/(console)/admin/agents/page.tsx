import { listAgentsForAdmin, listOpenInvites } from '@/lib/admin/settings';
import { requirePermission } from '@/lib/auth/guard';
import { unsealInviteToken } from '@/lib/auth/invite-token';
import { appUrl, env } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { loadPresencePolicy } from '@/lib/presence/policy';
import { AgentRow, IdlePolicyForm, InviteForm, PendingInviteLink } from './forms';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const admin = await requirePermission('admin.agents');

  const [policy, agentList, openInvites] = await Promise.all([
    loadPresencePolicy(),
    listAgentsForAdmin(),
    listOpenInvites(new Date()),
  ]);

  const hasStoredLinks = openInvites.some((invite) => invite.tokenCiphertext);
  let inviteBaseUrl: string | null = null;
  if (hasStoredLinks) {
    try {
      inviteBaseUrl = appUrl();
    } catch {
      // An invite that has already been sent remains usable by its hash. A
      // missing display-origin setting must not take down the whole Agents page.
    }
  }
  const appSecret = hasStoredLinks ? env().APP_SECRET : null;
  const pendingInvites = openInvites.map((invite) => {
    if (!invite.tokenCiphertext) {
      return {
        ...invite,
        inviteUrl: null,
        unavailableMessage:
          'This invite predates retained links. Create it again to keep a copy here.',
      };
    }
    if (!inviteBaseUrl || !appSecret) {
      return {
        ...invite,
        inviteUrl: null,
        unavailableMessage: 'APP_URL is not configured, so this link cannot be shown.',
      };
    }

    const token = unsealInviteToken(invite.tokenCiphertext, appSecret);
    return {
      ...invite,
      inviteUrl: token ? `${inviteBaseUrl}/invite/${token}` : null,
      unavailableMessage: token
        ? null
        : 'This retained link cannot be decrypted. Create the invite again to replace it.',
    };
  });

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
        <h2 className="mb-1 text-lg font-semibold">Idle agents</h2>
        {/* Above the invite form because it governs the list directly above it,
            and because "why is she away when she is clearly here?" is asked
            about that list rather than about anything else on this page. */}
        <p className="mb-3 text-sm text-[var(--muted-foreground)]">
          Measured from the last key or click in the console, not from being connected — a console
          left open on an empty desk stays connected all day. Supervisors can set anyone&rsquo;s
          availability by hand under Reports → Team availability.
        </p>
        <IdlePolicyForm
          autoAwayAfterMins={policy.autoAwayAfterMins}
          autoSignoutAfterMins={policy.autoSignoutAfterMins}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Invite an agent</h2>
        <InviteForm />
      </section>

      {pendingInvites.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-medium opacity-70">Pending invites</h2>
          <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
            {pendingInvites.map((invite) => (
              <li key={invite.id} className="flex flex-col gap-2 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 break-all">{invite.email}</span>
                  <span className="opacity-50">{invite.role}</span>
                  <span className="ms-auto text-xs opacity-50">
                    expires {formatDateTime(invite.expiresAt)}
                  </span>
                </div>
                <PendingInviteLink
                  email={invite.email}
                  inviteUrl={invite.inviteUrl}
                  unavailableMessage={invite.unavailableMessage}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
