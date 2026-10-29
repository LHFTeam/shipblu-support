import { PageHeader } from '@/components/ui';
import {
  listAgentsForAdmin,
  listGroupMemberships,
  listGroupNames,
  listNumberOwnerIds,
  listOpenInvites,
} from '@/lib/admin/settings';
import { requirePermission } from '@/lib/auth/guard';
import { unsealInviteToken } from '@/lib/auth/invite-token';
import { appUrl, env } from '@/lib/env';
import { formatDateTime } from '@/lib/format';
import { loadPresencePolicy } from '@/lib/presence/policy';
import { AgentList, IdlePolicyForm, InviteForm, PendingInviteLink } from './forms';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const admin = await requirePermission('admin.agents');

  const [policy, agentList, openInvites, groupRows, memberships, ownerIds] = await Promise.all([
    loadPresencePolicy(),
    listAgentsForAdmin(),
    listOpenInvites(new Date()),
    listGroupNames(),
    listGroupMemberships(),
    listNumberOwnerIds(),
  ]);
  const owners = new Set(ownerIds);

  const groupChoices = groupRows.map((group) => ({ value: group.id, label: group.name }));
  const groupName = new Map(groupRows.map((group) => [group.id, group.name]));

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
        <PageHeader title="Agents" />
        <AgentList
          agents={agentList.map((agent) => ({
            ...agent,
            groupIds: memberships
              .filter((row) => row.agentId === agent.id)
              .map((row) => row.groupId),
            ownsNumber: owners.has(agent.id),
          }))}
          groups={groupChoices}
          selfId={admin.id}
        />
      </section>

      <section>
        <h2 className="mb-1 text-lg font-semibold">Idle agents</h2>
        {/* Above the invite form because it governs the list directly above it,
            and because "why is she away when she is clearly here?" is asked
            about that list rather than about anything else on this page. */}
        <p className="mb-3 text-sm text-(--color-text-secondary)">
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
        <InviteForm groups={groupChoices} />
      </section>

      {pendingInvites.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-(--color-text-secondary)">
            Pending invites
          </h2>
          <ul className="divide-y divide-(--color-border-subtle) rounded-xl border border-(--color-border-subtle) bg-(--color-background-surface) text-sm">
            {pendingInvites.map((invite) => (
              <li key={invite.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 break-all">{invite.email}</span>
                  <span className="text-(--color-text-tertiary)">{invite.role}</span>
                  {/* What they join on accepting. A group deleted since is
                      skipped then, so it is left out here too. */}
                  {invite.groupIds.some((id) => groupName.has(id)) ? (
                    <span className="text-(--color-text-tertiary)">
                      {invite.groupIds.flatMap((id) => groupName.get(id) ?? []).join(' · ')}
                    </span>
                  ) : null}
                  <span className="ms-auto text-xs text-(--color-text-tertiary)">
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
