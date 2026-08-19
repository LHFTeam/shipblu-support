import { asc, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { conversations, groupMembers, groups } from '@/db/schema';
import { Cell, PageHeader, Row, Table } from '@/components/ui';
import { requirePermission } from '@/lib/auth/guard';
import { GroupEditor, NewGroup } from './forms';

export const dynamic = 'force-dynamic';

/**
 * Groups are how tickets get routed to a team rather than to a person, and what
 * the reports break down by, so this page shows both counts — an empty group
 * with tickets in it is a routing mistake worth seeing.
 */
export default async function GroupsPage() {
  await requirePermission('admin.groups');

  const rows = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      members: sql<number>`(select count(*)::int from ${groupMembers} gm where gm.group_id = ${groups.id})`,
      tickets: sql<number>`(select count(*)::int from ${conversations} c where c.group_id = ${groups.id})`,
    })
    .from(groups)
    .orderBy(asc(groups.name));

  return (
    <>
      <PageHeader
        title="Groups"
        description="Teams that tickets are routed to. A channel, an automation or an SLA policy can all put a ticket into one."
        actions={<NewGroup />}
      />

      <Table head={['Group', 'Agents', 'Tickets', '']}>
        {rows.map((group) => (
          <Row key={group.id}>
            <Cell>
              <GroupEditor
                group={{ id: group.id, name: group.name, description: group.description }}
              />
            </Cell>
            <Cell className="text-[var(--muted-foreground)]">{group.members}</Cell>
            <Cell className="text-[var(--muted-foreground)]">{group.tickets}</Cell>
            <Cell className="text-end">
              <GroupEditor
                group={{ id: group.id, name: group.name, description: group.description }}
                deleteOnly
              />
            </Cell>
          </Row>
        ))}
      </Table>

      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted-foreground)]">
          No groups yet. Every ticket goes to whoever picks it up.
        </p>
      ) : null}
    </>
  );
}
