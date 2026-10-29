'use server';

import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, businessHours, groups } from '@/db/schema';
import { agentsExist, applyGroupMembers, membershipChoice } from '@/lib/admin/group-members';
import { deleteGroupIfUnused } from '@/lib/admin/group-uses';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { optionalMinutes, text, uuidField } from '@/lib/http/form-data';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { GONE, MALFORMED, refresh, type SettingsState } from '../settings-shared';

// --- Groups -----------------------------------------------------------------

export async function saveGroup(_state: SettingsState, formData: FormData): Promise<SettingsState> {
  await requirePermission('admin.groups');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  const description = text(formData, 'description') || null;

  // Null means "work the default schedule" rather than "no hours at all", which
  // is why an empty select clears the override instead of being rejected.
  const businessHoursId = text(formData, 'businessHoursId') || null;

  if (!name) return { error: 'Give the group a name' };

  // The members picker posts which boxes it drew ticked beside which are
  // ticked now, so the save changes only the boxes somebody clicked
  // (`MembershipChoice`).
  const members = membershipChoice(formData, 'memberIds');
  if (!members) return { error: MALFORMED };
  if (!(await agentsExist(members))) {
    return { error: 'One of those agents no longer exists — reload the page and try again' };
  }

  if (businessHoursId) {
    const schedule = await db
      .select({ id: businessHours.id })
      .from(businessHours)
      .where(eq(businessHours.id, businessHoursId))
      .limit(1);
    if (!schedule.length) return { error: 'That schedule no longer exists' };
  }

  const strategy = text(formData, 'assignmentStrategy') || 'manual';
  if (!['manual', 'round_robin', 'load_balanced'].includes(strategy)) {
    return { error: 'Unknown assignment strategy' };
  }

  const escalateToAgentId = text(formData, 'escalateToAgentId') || null;
  if (escalateToAgentId) {
    const target = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, escalateToAgentId), eq(agents.isActive, true)))
      .limit(1);
    if (!target.length) return { error: 'That escalation contact is not an active agent' };
  }

  const assignment = {
    assignmentStrategy: strategy as 'manual' | 'round_robin' | 'load_balanced',
    // The whole assignment block is hidden when the strategy is manual, so the
    // browser submits none of its fields. Reading them anyway would clear an
    // admin's caps and timeouts every time they renamed the group; a group put
    // back on manual keeps its settings, waiting for the day it comes off again.
    ...(strategy === 'manual'
      ? {}
      : {
          matchSkills: text(formData, 'matchSkills') === 'on',
          skillTimeoutMins: optionalMinutes(formData, 'skillTimeoutMins'),
          defaultMaxOpenTickets: optionalMinutes(formData, 'defaultMaxOpenTickets'),
          assignWithinHoursOnly: text(formData, 'assignWithinHoursOnly') === 'on',
          reclaimAfterMins: optionalMinutes(formData, 'reclaimAfterMins'),
        }),
    escalateToAgentId,
    escalateAfterMins: optionalMinutes(formData, 'escalateAfterMins'),
  };

  // One transaction, so a new group is never left behind without the members
  // it was created with, and an edit's settings and roster land together.
  const refusal = await db.transaction(async (tx) => {
    let groupId: string;
    if (id) {
      const updated = await tx
        .update(groups)
        .set({ name, description, businessHoursId, ...assignment, updatedAt: new Date() })
        .where(eq(groups.id, id))
        .returning({ id: groups.id });
      // Deleted while the editor was open. Saying so is the answer either way,
      // and here it is also what keeps the members' insert off a foreign key.
      if (!updated.length) return GONE;
      groupId = id;
    } else {
      const existing = await tx.select({ id: groups.id }).from(groups).where(eq(groups.name, name));
      if (existing.length) return 'A group with that name already exists';
      const [created] = await tx
        .insert(groups)
        .values({ name, description, businessHoursId, ...assignment })
        .returning({ id: groups.id });
      groupId = created!.id;
    }
    await applyGroupMembers(tx, groupId, members);
    return null;
  });
  if (refusal) return { error: refusal };

  // A group's hours are the arithmetic behind every due date on its tickets, so
  // the SLA and reports pages are showing stale wording until they re-read.
  refresh('/admin/groups');
  // Its members are each agent's groups on the agents page, and the
  // route-group picker counts who could take a ticket now.
  refresh('/admin/agents');
  refresh('/admin/categories');
  // The catalogue is memoised for thirty seconds and a due date is computed
  // from it, so the process that took the edit drops its copy now rather than
  // serving a stale schedule to the next SLA calculation.
  forgetHoursCatalog();
  refresh('/admin/hours');
  return ok();
}

export async function deleteGroup(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.groups');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  // Tickets keep a group id; deleting one out from under them would leave the
  // inbox filtering on a group nobody can name. Channels and forms that start
  // their tickets in it, and rules, policies and skills that name it, are the
  // same question asked of where tickets will go next (`groupUses`).
  const refusal = await deleteGroupIfUnused(id);
  if (refusal) return { error: refusal };

  refresh('/admin/groups');
  // Same reason as `saveGroup`, and the easier one to forget: the catalogue
  // holds `groups.business_hours_id` as its override map, so a deleted group
  // that carried a schedule keeps resolving to it for the rest of the TTL, and
  // any due date computed in that window comes from a row that is gone.
  forgetHoursCatalog();
  return ok();
}
