'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  agentSkills,
  automationRules,
  internalRecipients,
  sideConversations,
  skills,
  channels,
  whatsappAccounts,
  shipmentPhrases,
} from '@/db/schema';
import { requirePermission } from '@/lib/auth/guard';
import { ok } from '@/lib/http/action-state';
import { int, text, uuidField } from '@/lib/http/form-data';
import { parseActions } from '@/lib/automations/actions';
import { parseCondition } from '@/lib/rules/conditions';
import { PHRASE_GROUPS } from '@/lib/shipments/status';
import { parseTokenEnvVar } from '@/lib/whatsapp/accounts';
import { validatePolicy } from '@/lib/presence/idle';
import { savePresencePolicy } from '@/lib/presence/policy';
import { errorMessage } from '@/lib/errors';
import { GONE, refresh, type SettingsState } from './settings-shared';

/**
 * Everything the admin screens write.
 *
 * Split from `./actions` — which handles agents, channels and the importer —
 * because this file is the configuration that phase 3 made the product depend
 * on: SLA policies, automation rules, business hours, statuses, fields and
 * canned responses. All of it existed as tables with no way to edit them.
 *
 * Two rules run through every action here. Conditions and actions are validated
 * with the same parsers the engines use, so a rule that saves is a rule that
 * will run — the alternative is an admin form that accepts something the sweep
 * then silently ignores. And anything a ticket points at is deactivated rather
 * than deleted when it is in use, because deleting it would either orphan the
 * ticket or take it with it.
 */

// --- Presence policy ---------------------------------------------------------

/**
 * When the console decides somebody has stopped working.
 *
 * Under `admin.agents` rather than a permission of its own: it is a rule about
 * the team, and it sits on the page that lists them.
 *
 * Blank means the timer is off, and that is the only way to turn one off — so
 * an unreadable value has to be an error rather than a silent null, which is
 * what `optionalMinutes` above would give. A typo quietly disabling the
 * sign-out is exactly the failure this form must not have: nothing would look
 * wrong afterwards, because "nobody was ever signed out" and "the timeout is
 * working" look identical from the outside.
 *
 * Everything else about the numbers — whole, in range, and the sign-out no
 * shorter than the away — is `validatePolicy`'s, so the form and the tests
 * agree on the wording of each refusal.
 */
export async function savePresenceSettings(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const admin = await requirePermission('admin.agents');

  const away = minutesOrOff(formData, 'autoAwayAfterMins');
  const signout = minutesOrOff(formData, 'autoSignoutAfterMins');

  if (away === 'not_a_number' || signout === 'not_a_number') {
    return { error: 'Enter a number of minutes, or leave the box empty to turn it off.' };
  }

  const policy = { autoAwayAfterMins: away, autoSignoutAfterMins: signout };
  const problem = validatePolicy(policy);
  if (problem) return { error: problem };

  await savePresencePolicy(policy, admin.id);

  refresh('/admin/agents');
  return ok();
}

/**
 * Blank is "off", anything numeric is a window, and text is the admin's typo.
 *
 * Deliberately does *not* check that the number is whole or in range —
 * `validatePolicy` owns both, and it has the wording for each. Checking here
 * too made that function's "has to be a whole number of minutes" message
 * unreachable from the only form that writes these, which is how a tested
 * message ends up being one nobody can ever see.
 */
function minutesOrOff(formData: FormData, key: string): number | null | 'not_a_number' {
  const raw = text(formData, key);
  if (!raw) return null;

  const value = Number(raw);
  return Number.isFinite(value) ? value : 'not_a_number';
}

// --- Automation rules -------------------------------------------------------

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

export async function saveAutomationRule(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.automations');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  const trigger = text(formData, 'trigger');
  const position = int(formData, 'position');
  const isActive = formData.get('isActive') !== 'off';
  const stopProcessing = formData.get('stopProcessing') === 'on';

  if (!name) return { error: 'Give the rule a name' };
  if (!['on_create', 'on_update', 'time_based'].includes(trigger)) {
    return { error: 'Pick when the rule runs' };
  }

  let conditions: unknown;
  try {
    conditions = JSON.parse(text(formData, 'conditions') || '{}');
  } catch {
    return { error: 'The conditions are not valid JSON' };
  }
  if (!parseCondition(conditions)) {
    return { error: 'Those conditions are not a shape the automation engine understands' };
  }

  let rawActions: unknown;
  try {
    rawActions = JSON.parse(text(formData, 'actions') || '[]');
  } catch {
    return { error: 'The actions are not valid JSON' };
  }

  const parsedActions = parseActions(rawActions);
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    return { error: 'A rule with no actions would do nothing' };
  }
  if (parsedActions.length !== rawActions.length) {
    // Saving a rule whose actions are partly unrecognised is how an admin ends
    // up believing something happens that never does.
    return { error: 'One or more actions are not recognised — check the action list' };
  }

  const values = {
    name,
    trigger: trigger as 'on_create' | 'on_update' | 'time_based',
    conditions,
    actions: rawActions as unknown[],
    position,
    isActive,
    stopProcessing,
    updatedAt: new Date(),
  };

  if (id) {
    await db.update(automationRules).set(values).where(eq(automationRules.id, id));
  } else {
    await db.insert(automationRules).values(values);
  }

  refresh('/admin/automations');
  return ok();
}

export async function deleteAutomationRule(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.automations');
  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };
  await db.delete(automationRules).where(eq(automationRules.id, id));
  refresh('/admin/automations');
  return ok();
}

// --- Internal recipients ----------------------------------------------------

/**
 * The directory a side conversation is addressed from.
 *
 * This screen exists so that reaching the Downtown hub is a choice from a list
 * rather than an address typed from memory. The difference is not convenience:
 * `hub-downton@shipblu.com` is a live domain somebody else could own, and the
 * mail sent there carries a customer's name, their address and their complaint.
 *
 * Deactivated rather than deleted while any thread points at one, on the same
 * rule as every other row on these screens — and with a second reason here.
 * `side_conversations.recipient_id` is `ON DELETE SET NULL`, so deleting a hub
 * would blank the recipient on every thread ever sent to it, turning last
 * month's record of who was asked into a row of nulls.
 */
export async function saveInternalRecipient(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.channels');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  // Lowercased on write, because the unique index and every lookup compare the
  // canonical form — the same discipline contact_identities needs.
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const kind = String(formData.get('kind') ?? 'hub');
  const description = text(formData, 'description') || null;
  const isActive = formData.get('isActive') === 'on';

  if (!name) return { error: 'Give this recipient a name agents will recognise' };
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) {
    return { error: 'Enter a valid email address' };
  }
  // No 'hub'. A hub is a `locations` row, which is a register somebody else's
  // screen owns; letting one be entered here would mean the Downtown hub's
  // address is maintained in two places with nothing keeping them in step.
  if (!['team', 'vendor'].includes(kind)) return { error: 'Unknown kind' };

  const values = {
    name,
    email,
    kind: kind as 'team' | 'vendor',
    description,
    isActive,
  };

  try {
    if (id) {
      await db.update(internalRecipients).set(values).where(eq(internalRecipients.id, id));
    } else {
      await db.insert(internalRecipients).values(values);
    }
  } catch (error) {
    // Both name and email are unique. Two entries for one hub is worse than it
    // sounds: the picker shows the same words twice and an agent has no way to
    // tell which is the address anyone reads.
    const message = errorMessage(error);
    if (message.includes('internal_recipients_email_idx')) {
      return { error: 'Another recipient already uses that address' };
    }
    if (message.includes('internal_recipients_name_idx')) {
      return { error: 'Another recipient already has that name' };
    }
    throw error;
  }

  revalidatePath('/admin/recipients');
  return ok();
}

export async function deleteInternalRecipient(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.channels');

  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  const inUse = await db
    .select({ id: sideConversations.id })
    .from(sideConversations)
    .where(eq(sideConversations.recipientId, id))
    .limit(1);

  if (inUse.length > 0) {
    // Deactivated instead, so the picker loses it and the history keeps it.
    await db
      .update(internalRecipients)
      .set({ isActive: false })
      .where(eq(internalRecipients.id, id));

    revalidatePath('/admin/recipients');
    return {
      error:
        'That recipient has side conversations, so it was deactivated rather than deleted. It is gone from the picker and the old threads still say who was asked.',
    };
  }

  await db.delete(internalRecipients).where(eq(internalRecipients.id, id));

  revalidatePath('/admin/recipients');
  return ok();
}

// --- WhatsApp business accounts ---------------------------------------------

/**
 * Connect or edit one WABA.
 *
 * The row holds ids and a *name* of an environment variable, never a token —
 * the same rule the channels table follows. `parseTokenEnvVar` is what enforces
 * it: an admin free to type any variable name would be choosing which of the
 * process's secrets gets posted to Meta as a bearer token, and would never see
 * the value to know it had happened.
 */
export async function saveWhatsAppAccount(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.channels');

  const id = uuidField(formData, 'id');
  if (id === undefined) return { error: GONE };
  const name = text(formData, 'name');
  const wabaId = text(formData, 'wabaId');
  const isDefault = formData.get('isDefault') === 'on';
  const isActive = formData.get('isActive') === 'on';

  if (!name) return { error: 'Give the business account a name' };
  // Meta's ids are numeric strings. Checked because the failure otherwise is a
  // Graph 400 an hour later in the cron log, not here where it can be fixed.
  if (!/^\d{5,}$/.test(wabaId)) {
    return {
      error:
        'The WhatsApp Business Account ID is the numeric id from Meta’s WhatsApp Manager — not the phone number and not the name.',
    };
  }

  const token = parseTokenEnvVar(String(formData.get('tokenEnvVar') ?? ''));
  if (!token.ok) return { error: token.error };

  const clash = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(and(eq(whatsappAccounts.wabaId, wabaId), id ? ne(whatsappAccounts.id, id) : sql`true`))
    .limit(1);

  if (clash.length > 0) {
    return { error: 'Another connection already uses that business account id.' };
  }

  const values = {
    name,
    wabaId,
    tokenEnvVar: token.value,
    isDefault,
    isActive,
    updatedAt: new Date(),
  };

  const saved = id
    ? await db
        .update(whatsappAccounts)
        .set(values)
        .where(eq(whatsappAccounts.id, id))
        .returning({ id: whatsappAccounts.id })
    : await db.insert(whatsappAccounts).values(values).returning({ id: whatsappAccounts.id });

  const savedId = saved[0]?.id;
  if (!savedId) return { error: 'That business account no longer exists.' };

  // Exactly one default, enforced here rather than by a partial unique index:
  // the index would reject the *save* that creates the second default and leave
  // the admin to work out which existing row to clear first, when what they
  // asked for is unambiguous.
  if (isDefault) {
    await db
      .update(whatsappAccounts)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(ne(whatsappAccounts.id, savedId));
  }

  refresh('/admin/channels');
  return ok();
}

/**
 * Disconnect a WABA.
 *
 * Its templates go with it — they are a cache of what that account holds, and
 * with the account gone there is no number left to send them from. Numbers
 * pointing at it are detached by the `set null` on the foreign key rather than
 * deleted: a channel row is where a ticket's history is anchored, and taking it
 * with the connection would orphan every conversation that arrived on it.
 */
export async function deleteWhatsAppAccount(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.channels');

  const id = uuidField(formData, 'id');
  if (!id) return { error: 'Nothing to delete' };

  const numbers = await db
    .select({ name: channels.name })
    .from(channels)
    .where(and(eq(channels.whatsappAccountId, id), eq(channels.isActive, true)));

  if (numbers.length > 0) {
    // Deactivated rather than deleted, for the same reason as everywhere else
    // in this file: the numbers would silently fall back to the default account
    // and start replying from the wrong business — which Meta rejects on a
    // status webhook nobody is watching.
    await db
      .update(whatsappAccounts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(whatsappAccounts.id, id));

    refresh('/admin/channels');
    return {
      error: `${numbers.map((number) => number.name).join(', ')} still send on that business account, so it was switched off rather than disconnected. Point them somewhere else first.`,
    };
  }

  await db.delete(whatsappAccounts).where(eq(whatsappAccounts.id, id));

  refresh('/admin/channels');
  return ok();
}

/**
 * Every key `/admin/tracking` is allowed to write.
 *
 * Built from the catalogue rather than trusted from the form. A `key` arriving
 * in a `FormData` field is attacker-controlled like any other, and without this
 * the action would insert whatever string it was handed — filling
 * `shipment_phrases` with rows no page will ever read, and turning a screen for
 * editing twenty-three phrases into an open key-value store.
 */
const PHRASE_KEYS = new Set(PHRASE_GROUPS.flatMap((group) => group.rows.map((row) => row.key)));

/**
 * Save one Arabic phrase for the public tracking page, or clear it.
 *
 * Clearing deletes the row rather than storing an empty string, so the default
 * compiled into `lib/shipments/status.ts` comes back — an empty override would
 * otherwise render a status badge with nothing in it, which says less to a
 * customer than the English word it replaced.
 *
 * No `revalidatePath` for the public page: `/[locale]/track` is `force-dynamic`
 * and reads `shipment_phrases` on every request, and it is served on a different
 * host from this one. The admin table is revalidated so the editor sees its own
 * change.
 */
export async function saveTrackingPhrase(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const agent = await requirePermission('admin.fields');

  const key = text(formData, 'key');
  if (!PHRASE_KEYS.has(key)) return { error: 'Unknown phrase' };

  const ar = text(formData, 'ar');

  if (!ar) {
    await db.delete(shipmentPhrases).where(eq(shipmentPhrases.key, key));
    refresh('/admin/tracking');
    return ok();
  }

  await db
    .insert(shipmentPhrases)
    .values({ key, ar, updatedBy: agent.id })
    .onConflictDoUpdate({
      target: shipmentPhrases.key,
      set: { ar, updatedAt: new Date(), updatedBy: agent.id },
    });

  refresh('/admin/tracking');
  return ok();
}
