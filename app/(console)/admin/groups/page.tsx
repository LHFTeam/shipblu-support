import { asc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { businessHours, conversations, groupMembers, groups } from '@/db/schema';
import { Cell, PageHeader, Row, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { GroupEditor, NewGroup } from './forms';

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

  const [rows, schedules] = await Promise.all([
    db
      .select({
        id: groups.id,
        name: groups.name,
        description: groups.description,
        businessHoursId: groups.businessHoursId,
        members: sql<number>`(select count(*)::int from ${groupMembers} gm where gm.group_id = ${groups.id})`,
        tickets: sql<number>`(select count(*)::int from ${conversations} c where c.group_id = ${groups.id})`,
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
  ]);

  const scheduleChoices = schedules.map((schedule) => ({
    value: schedule.id,
    label: schedule.name,
  }));
  const defaultName = schedules.find((schedule) => schedule.isDefault)?.name ?? null;

  return (
    <>
      <PageHeader
        title="Groups"
        description="Teams that tickets are routed to. A channel, an automation or an SLA policy can all put a ticket into one. A group can also work its own hours, days and holidays."
        actions={<NewGroup schedules={scheduleChoices} />}
      />

      <Table head={['Group', 'Business hours', 'Agents', 'Tickets', '']}>
        {rows.map((group) => {
          const editable = {
            id: group.id,
            name: group.name,
            description: group.description,
            businessHoursId: group.businessHoursId,
          };
          const own = schedules.find((schedule) => schedule.id === group.businessHoursId);

          return (
            <Row key={group.id}>
              <Cell>
                <GroupEditor group={editable} schedules={scheduleChoices} />
              </Cell>
              <Cell className="text-[var(--muted-foreground)]">
                {own ? (
                  own.name
                ) : (
                  <span className="text-xs">{defaultName ? `${defaultName} (default)` : '—'}</span>
                )}
              </Cell>
              <Cell className="text-[var(--muted-foreground)]">{group.members}</Cell>
              <Cell className="text-[var(--muted-foreground)]">{group.tickets}</Cell>
              <Cell className="text-end">
                <GroupEditor group={editable} schedules={scheduleChoices} deleteOnly />
              </Cell>
            </Row>
          );
        })}
      </Table>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted-foreground)]">
          No groups yet. Every ticket goes to whoever picks it up.
        </p>
      ) : null}
    </>
  );
}
