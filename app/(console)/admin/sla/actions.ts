'use server';

import { eq, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { businessHours, slaPolicies, conversations } from '@/db/schema';
import type { SlaTargets } from '@/db/schema/config';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { int, optionalMinutes, text, uuidField } from '@/lib/http/form-data';
import { parseCondition } from '@/lib/rules/conditions';
import { PRIORITIES } from '@/lib/tickets/vocabulary';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- SLA policies -----------------------------------------------------------

const HOURS_SOURCES = ['group', 'schedule', 'round_the_clock'] as const;
type HoursSourceValue = (typeof HOURS_SOURCES)[number];

/**
 * Which calendar the policy counts against.
 *
 * Falls back to `group` rather than erroring: that is the setting that respects
 * both the company schedule and a team's own, so an unrecognised value lands on
 * the safe answer instead of quietly making the policy round-the-clock.
 */
function hoursSourceOf(formData: FormData): HoursSourceValue {
  const value = text(formData, 'hoursSource');
  return (HOURS_SOURCES as readonly string[]).includes(value)
    ? (value as HoursSourceValue)
    : 'group';
}

export async function saveSlaPolicy(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  const description = text(formData, 'description') || null;
  const position = int(formData, 'position');
  const isDefault = formData.get('isDefault') === 'on';
  const isActive = formData.get('isActive') !== 'off';

  if (!name) return { error: 'Give the policy a name' };

  const hoursSource = hoursSourceOf(formData);
  const businessHoursId = hoursSource === 'schedule' ? text(formData, 'businessHoursId') : '';
  if (hoursSource === 'schedule') {
    if (!businessHoursId) return { error: 'Pick the schedule this policy counts against' };

    // Checked here so a deleted schedule comes back as a sentence rather than a
    // foreign key violation thrown out of a server action.
    const schedule = await db
      .select({ id: businessHours.id })
      .from(businessHours)
      .where(eq(businessHours.id, businessHoursId))
      .limit(1);
    if (!schedule.length) return { error: 'That schedule no longer exists' };
  }

  // Validated with the engine's own parser, so a policy that saves is a policy
  // that will actually match something.
  const rawConditions = text(formData, 'conditions') || '{}';
  let conditions: unknown;
  try {
    conditions = JSON.parse(rawConditions);
  } catch {
    return { error: 'The conditions are not valid JSON' };
  }
  if (!parseCondition(conditions)) {
    return { error: 'Those conditions are not a shape the SLA engine understands' };
  }

  const targets = {} as SlaTargets;
  for (const priority of PRIORITIES) {
    targets[priority] = {
      firstResponseMins: optionalMinutes(formData, `${priority}_first`),
      nextResponseMins: optionalMinutes(formData, `${priority}_next`),
      resolutionMins: optionalMinutes(formData, `${priority}_resolution`),
    };
  }

  const escalationAgentIds = String(formData.get('escalationAgentIds') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const escalations = escalationAgentIds.length
    ? {
        firstResponse: { afterMins: int(formData, 'escalateAfter'), agentIds: escalationAgentIds },
        resolution: { afterMins: int(formData, 'escalateAfter'), agentIds: escalationAgentIds },
      }
    : {};

  const values = {
    name,
    description,
    conditions,
    targets,
    escalations,
    hoursSource,
    // Cleared unless a schedule is actually named, so a policy switched to the
    // group's hours does not keep a stale schedule that a later switch back
    // would silently resurrect.
    businessHoursId: businessHoursId || null,
    position,
    isDefault,
    isActive,
    updatedAt: new Date(),
  };

  await db.transaction(async (tx) => {
    if (isDefault) {
      await tx
        .update(slaPolicies)
        .set({ isDefault: false })
        .where(id ? ne(slaPolicies.id, id) : sql`true`);
    }

    if (id) {
      await tx.update(slaPolicies).set(values).where(eq(slaPolicies.id, id));
    } else {
      await tx.insert(slaPolicies).values(values);
    }
  });

  refresh('/admin/sla');
  return ok();
}

export async function deleteSlaPolicy(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  // Tickets point at the policy for reporting; the column nulls out on delete,
  // which would quietly rewrite history. Deactivating keeps the record.
  const inUse = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.slaPolicyId, id));

  if ((inUse[0]?.count ?? 0) > 0) {
    await db.update(slaPolicies).set({ isActive: false }).where(eq(slaPolicies.id, id));
    refresh('/admin/sla');
    return ok();
  }

  await db.delete(slaPolicies).where(eq(slaPolicies.id, id));
  refresh('/admin/sla');
  return ok();
}
