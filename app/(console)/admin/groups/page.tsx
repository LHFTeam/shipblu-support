import { PageHeader } from '@/components/ui';
import { listActiveAgents, listGroupsForAdmin, listScheduleOptions } from '@/lib/admin/settings';
import { requirePermission } from '@/lib/auth/guard';
import { GroupsTable, NewGroup } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Groups are how tickets get routed to a team rather than to a person, and what
 * the reports break down by, so this page shows both counts — an empty group
 * with tickets in it is a routing mistake worth seeing.
 *
 * A group may also keep its own business hours, which is why the schedule is a
 * column here rather than buried in the editor: whether a team's tickets are
 * counted on the company calendar or its own is worth being able to read down
 * the list.
 */
export default async function GroupsPage() {
  await requirePermission('admin.groups');

  const [rows, schedules, agentRows] = await Promise.all([
    listGroupsForAdmin(),
    listScheduleOptions(),
    listActiveAgents(),
  ]);

  const scheduleChoices = schedules.map((schedule) => ({
    value: schedule.id,
    label: schedule.name,
  }));
  const defaultName = schedules.find((schedule) => schedule.isDefault)?.name ?? null;
  const agentChoices = agentRows.map((agent) => ({
    value: agent.id,
    label: agent.name || agent.email,
  }));

  return (
    <>
      <PageHeader
        title="Groups"
        description="Teams that tickets are routed to. A channel, an automation or an SLA policy can all put a ticket into one. A group can also work its own hours, days and holidays, and hand its tickets out to its members automatically."
        actions={<NewGroup schedules={scheduleChoices} agents={agentChoices} />}
      />

      <GroupsTable
        rows={rows.map(({ members, tickets, ...group }) => ({
          group,
          scheduleName:
            schedules.find((schedule) => schedule.id === group.businessHoursId)?.name ?? null,
          members,
          tickets,
        }))}
        schedules={scheduleChoices}
        agents={agentChoices}
        defaultScheduleName={defaultName}
      />

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted-foreground)]">
          No groups yet. Every ticket goes to whoever picks it up.
        </p>
      ) : null}
    </>
  );
}
