'use server';

import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, businessHours, groups, conversations } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { optionalMinutes, text, uuidField } from '@/lib/http/form-data';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { GONE, refresh, type SettingsState } from '../settings-shared';

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

  if (id) {
    await db
      .update(groups)
      .set({ name, description, businessHoursId, ...assignment, updatedAt: new Date() })
      .where(eq(groups.id, id));
  } else {
    const existing = await db.select({ id: groups.id }).from(groups).where(eq(groups.name, name));
    if (existing.length) return { error: 'A group with that name already exists' };
    await db.insert(groups).values({ name, description, businessHoursId, ...assignment });
  }

  // A group's hours are the arithmetic behind every due date on its tickets, so
  // the SLA and reports pages are showing stale wording until they re-read.
  refresh('/admin/groups');
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
  // inbox filtering on a group nobody can name.
  const inUse = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.groupId, id));

  if ((inUse[0]?.count ?? 0) > 0) {
    return { error: `That group is on ${inUse[0]!.count} ticket(s). Reassign them first.` };
  }

  await db.delete(groups).where(eq(groups.id, id));
  refresh('/admin/groups');
  // Same reason as `saveGroup`, and the easier one to forget: the catalogue
  // holds `groups.business_hours_id` as its override map, so a deleted group
  // that carried a schedule keeps resolving to it for the rest of the TTL, and
  // any due date computed in that window comes from a row that is gone.
  forgetHoursCatalog();
  return ok();
}
