'use server';

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { agents, agentSkills, skills } from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { int, text, uuidField } from '@/lib/http/form-data';
import { parseCondition } from '@/lib/rules/conditions';
import { GONE, refresh, type SettingsState } from '../settings-shared';

// --- Skills -----------------------------------------------------------------

/**
 * A skill and the agents who hold it, saved together.
 *
 * One form and one transaction, because the two halves are useless apart: a
 * skill nobody holds stops every ticket that matches it, and an agent holding a
 * skill nothing matches does nothing at all. Splitting them across two screens
 * would make the broken intermediate state the one an admin passes through every
 * time.
 *
 * The conditions are parsed by the engine that consumes them before anything is
 * stored, exactly as automation rules and SLA policies are — so a skill that
 * saves is a skill that will be evaluated, rather than one the assignment engine
 * silently ignores.
 */
export async function saveSkill(_state: SettingsState, formData: FormData): Promise<SettingsState> {
  await requirePermission('admin.skills');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  const description = text(formData, 'description') || null;
  const position = int(formData, 'position');
  const isActive = formData.get('isActive') !== 'off';

  if (!name) return { error: 'Give the skill a name' };

  let conditions: unknown;
  try {
    conditions = JSON.parse(text(formData, 'conditions') || '{}');
  } catch {
    return { error: 'The conditions are not valid JSON' };
  }
  if (!parseCondition(conditions)) {
    return { error: 'Those conditions are not a shape the assignment engine understands' };
  }

  const agentIds = formData
    .getAll('agentIds')
    .map((value) => String(value))
    .filter(Boolean);

  if (agentIds.length > 0) {
    const found = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(inArray(agents.id, agentIds), eq(agents.isActive, true)));
    if (found.length !== agentIds.length) {
      return { error: 'One of those agents is no longer active' };
    }
  }

  const skillId = await db.transaction(async (tx) => {
    let target = id;

    if (target) {
      await tx
        .update(skills)
        .set({ name, description, conditions, position, isActive, updatedAt: new Date() })
        .where(eq(skills.id, target));
    } else {
      const existing = await tx
        .select({ id: skills.id })
        .from(skills)
        .where(eq(skills.name, name))
        .limit(1);
      if (existing.length) return null;

      const created = await tx
        .insert(skills)
        .values({ name, description, conditions, position, isActive })
        .returning({ id: skills.id });
      target = created[0]?.id ?? '';
    }

    if (!target) return null;

    // Replaced wholesale rather than diffed: the form submits the complete set
    // of holders, so anybody absent from it was unticked.
    await tx.delete(agentSkills).where(eq(agentSkills.skillId, target));
    if (agentIds.length > 0) {
      await tx
        .insert(agentSkills)
        .values(agentIds.map((agentId) => ({ agentId, skillId: target })));
    }

    return target;
  });

  if (!skillId) return { error: 'A skill with that name already exists' };

  refresh('/admin/skills');
  refresh('/admin/groups');
  return ok();
}

/**
 * Skills are deleted rather than deactivated.
 *
 * The opposite of the rule that governs groups and statuses, and for the reason
 * that rule exists: those are things a ticket *points at*, so removing one would
 * orphan rows. Nothing points at a skill. It is derived from a ticket at the
 * moment of assignment and referenced only by `agent_skills`, which cascades —
 * so a deleted skill leaves nothing behind, and leaving a dead one switched off
 * in the list would only be a thing to misread later.
 */
export async function deleteSkill(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.skills');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  await db.delete(skills).where(eq(skills.id, id));

  refresh('/admin/skills');
  refresh('/admin/groups');
  return ok();
}
