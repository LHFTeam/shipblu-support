import { asc, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, businessHours, conversations, groupMembers, groups } from '@/db/schema';
import { PageHeader } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { readOnlyChannels } from '@/lib/tickets/channel-policy';
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
    db
      .select({
        id: groups.id,
        name: groups.name,
        description: groups.description,
        businessHoursId: groups.businessHoursId,
        assignmentStrategy: groups.assignmentStrategy,
        matchSkills: groups.matchSkills,
        skillTimeoutMins: groups.skillTimeoutMins,
        defaultMaxOpenTickets: groups.defaultMaxOpenTickets,
        assignWithinHoursOnly: groups.assignWithinHoursOnly,
        reclaimAfterMins: groups.reclaimAfterMins,
        escalateToAgentId: groups.escalateToAgentId,
        escalateAfterMins: groups.escalateAfterMins,
        members: sql<number>`(select count(*)::int from ${groupMembers} gm where gm.group_id = ${groups.id})`,
        // Read-only channels excluded: this number is "how much work sits with
        // this group", and a transcript nobody may answer is not work. It would
        // only ever be wrong once someone set a default group on the bot
        // channel, which is exactly the day nobody would think to check here.
        /*
         * How much work sits with this group. A transcript nobody may answer is
         * not work, so read-only channels are out.
         *
         * Two things about the shape of this. The correlation is written
         * `${groups}.id`, not `${groups.id}`: inside a select-clause subquery
         * drizzle renders a column reference *unqualified*, so `${groups.id}`
         * became a bare "id", which Postgres resolved against the innermost
         * table — the subquery compared conversations.group_id to
         * conversations.id and every group reported zero tickets. And the
         * channel test uses drizzle's operator rather than `<> all(...)`,
         * because a JS array interpolated into a `sql` template arrives as one
         * scalar parameter that Postgres rejects as malformed array input.
         */
        tickets: sql<number>`(
          select count(*)::int from ${conversations}
          where ${conversations.groupId} = ${groups}.id
            and ${notInArray(conversations.channel, readOnlyChannels())}
        )`,
      })
      .from(groups)
      .orderBy(asc(groups.name)),
    db
      .select({
        id: businessHours.id,
        name: businessHours.name,
        isDefault: businessHours.isDefault,
      })
      .from(businessHours)
      .orderBy(asc(businessHours.name)),
    db
      .select({ id: agents.id, name: agents.name, email: agents.email })
      .from(agents)
      .where(eq(agents.isActive, true))
      .orderBy(asc(agents.name)),
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
