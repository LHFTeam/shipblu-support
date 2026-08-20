'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  automationRules,
  businessHours,
  cannedResponses,
  holidays,
  locations,
  slaPolicies,
  ticketFields,
  ticketStatuses,
  groups,
  conversations,
  internalRecipients,
  sideConversations,
} from '@/db/schema';
import type { SlaTargets, WeeklySchedule } from '@/db/schema/config';
import { requirePermission } from '@/lib/auth/guard';
import { looksLikeEmail, normaliseEmail } from '@/lib/auth/normalise';
import { parseActions } from '@/lib/automations/actions';
import {
  isValidLocationCode,
  normaliseLocationCode,
  LOCATION_CODE_MAX,
} from '@/lib/locations/format';
import { parseCondition } from '@/lib/rules/conditions';

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

export type SettingsState = { error: string | null; ok?: boolean; nonce?: number };

const OK: SettingsState = { error: null, ok: true };
function ok(): SettingsState {
  return { ...OK, nonce: Date.now() };
}

function refresh(path: string) {
  revalidatePath(path);
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

function int(formData: FormData, key: string, fallback = 0): number {
  const value = Number(formData.get(key));
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function optionalMinutes(formData: FormData, key: string): number | null {
  const raw = text(formData, key);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

// --- Groups -----------------------------------------------------------------

export async function saveGroup(_state: SettingsState, formData: FormData): Promise<SettingsState> {
  await requirePermission('admin.groups');

  const id = text(formData, 'id');
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

  if (id) {
    await db
      .update(groups)
      .set({ name, description, businessHoursId, updatedAt: new Date() })
      .where(eq(groups.id, id));
  } else {
    const existing = await db.select({ id: groups.id }).from(groups).where(eq(groups.name, name));
    if (existing.length) return { error: 'A group with that name already exists' };
    await db.insert(groups).values({ name, description, businessHoursId });
  }

  // A group's hours are the arithmetic behind every due date on its tickets, so
  // the SLA and reports pages are showing stale wording until they re-read.
  refresh('/admin/groups');
  refresh('/admin/hours');
  return ok();
}

export async function deleteGroup(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.groups');
  const id = text(formData, 'id');

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
  return ok();
}

// --- Locations --------------------------------------------------------------

/**
 * ShipBlu's own locations.
 *
 * Both identifiers are normalised before the uniqueness check, so `cai-1` and
 * `CAI-1` collide instead of becoming two hubs — and they are checked here, with
 * a sentence naming the location already using them, rather than left to the
 * unique index. A 23505 reaching the form is a stack trace where an explanation
 * belongs, and "which location has that code?" is the question an admin
 * entering sixteen of them actually has.
 */
export async function saveLocation(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.locations');

  const id = text(formData, 'id');
  const name = text(formData, 'name');
  const code = normaliseLocationCode(text(formData, 'code'));
  const email = normaliseEmail(text(formData, 'email'));
  const isActive = formData.get('isActive') === 'on';

  if (!name) return { error: 'Give the location a name' };
  if (!isValidLocationCode(code)) {
    return {
      error: `A code is 2 to ${LOCATION_CODE_MAX} letters, digits or hyphens — for example CAI-1`,
    };
  }
  if (!looksLikeEmail(email)) return { error: "Enter the location's email address" };

  const clash = await db
    .select({
      id: locations.id,
      name: locations.name,
      code: locations.code,
      email: locations.email,
    })
    .from(locations)
    .where(or(eq(locations.code, code), eq(locations.email, email)));

  const other = clash.find((row) => row.id !== id);
  if (other) {
    return {
      error:
        other.code === code
          ? `${other.name} already uses the code ${code}`
          : `${other.name} already uses ${email}`,
    };
  }

  if (id) {
    await db
      .update(locations)
      .set({ name, code, email, isActive, updatedAt: new Date() })
      .where(eq(locations.id, id));
  } else {
    await db.insert(locations).values({ name, code, email, isActive });
  }

  refresh('/admin/locations');
  return ok();
}

/**
 * Deletes a location outright.
 *
 * Safe today only because nothing references a location yet: no agent carries
 * one, no ticket is attributed to one. The moment something does, this needs the
 * in-use guard `deleteGroup` has — and `is_active` is already the right answer
 * for a hub that has closed but whose code appears in history.
 */
export async function deleteLocation(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.locations');

  await db.delete(locations).where(eq(locations.id, text(formData, 'id')));
  refresh('/admin/locations');
  return ok();
}

// --- Ticket statuses --------------------------------------------------------

export async function saveStatus(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');

  const id = text(formData, 'id');
  const name = text(formData, 'name');
  const category = text(formData, 'category');
  const stopsSlaClock = formData.get('stopsSlaClock') === 'on';
  const visibleToCustomer = formData.get('visibleToCustomer') === 'on';
  const customerLabel = text(formData, 'customerLabel') || null;
  const position = int(formData, 'position');
  const isDefault = formData.get('isDefault') === 'on';

  if (!name) return { error: 'Give the status a name' };
  if (!['open', 'pending', 'resolved', 'closed'].includes(category)) {
    return { error: 'Pick a category' };
  }

  const values = {
    name,
    category: category as 'open' | 'pending' | 'resolved' | 'closed',
    stopsSlaClock,
    visibleToCustomer,
    customerLabel,
    position,
    isDefault,
  };

  await db.transaction(async (tx) => {
    // Exactly one default per category, or ingest picks arbitrarily between them.
    if (isDefault) {
      await tx
        .update(ticketStatuses)
        .set({ isDefault: false })
        .where(
          and(
            eq(ticketStatuses.category, values.category),
            id ? ne(ticketStatuses.id, id) : sql`true`,
          ),
        );
    }

    if (id) {
      await tx.update(ticketStatuses).set(values).where(eq(ticketStatuses.id, id));
    } else {
      await tx.insert(ticketStatuses).values(values);
    }
  });

  refresh('/admin/statuses');
  return ok();
}

export async function deleteStatus(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');
  const id = text(formData, 'id');

  const rows = await db
    .select({ isSystem: ticketStatuses.isSystem })
    .from(ticketStatuses)
    .where(eq(ticketStatuses.id, id))
    .limit(1);

  if (rows[0]?.isSystem) return { error: 'That status is built in and cannot be deleted' };

  const inUse = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.statusId, id));

  if ((inUse[0]?.count ?? 0) > 0) {
    return { error: `That status is on ${inUse[0]!.count} ticket(s). Move them first.` };
  }

  await db.delete(ticketStatuses).where(eq(ticketStatuses.id, id));
  refresh('/admin/statuses');
  return ok();
}

// --- Ticket fields ----------------------------------------------------------

const FIELD_TYPES = [
  'text',
  'paragraph',
  'number',
  'decimal',
  'checkbox',
  'dropdown',
  'multi_select',
  'date',
  'datetime',
] as const;

export async function saveField(_state: SettingsState, formData: FormData): Promise<SettingsState> {
  await requirePermission('admin.fields');

  const id = text(formData, 'id');
  const key = text(formData, 'key');
  const label = text(formData, 'label');
  const type = text(formData, 'type');

  if (!label) return { error: 'Give the field a label' };
  if (!FIELD_TYPES.includes(type as (typeof FIELD_TYPES)[number])) {
    return { error: 'Pick a field type' };
  }

  // The key is what `custom.<key>` refers to in a rule, so it has to be stable
  // and safe to write in a condition.
  if (!id && !/^[a-z][a-z0-9_]*$/.test(key)) {
    return {
      error: 'The key must be lowercase letters, numbers and underscores, starting with a letter',
    };
  }

  const options = text(formData, 'options')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value, ...rest] = line.split('|');
      return { value: value!.trim(), label: (rest.join('|') || value!).trim() };
    });

  const values = {
    label,
    type: type as (typeof FIELD_TYPES)[number],
    options,
    requiredOnCreate: formData.get('requiredOnCreate') === 'on',
    requiredOnResolve: formData.get('requiredOnResolve') === 'on',
    visibleToCustomer: formData.get('visibleToCustomer') === 'on',
    editableByCustomer: formData.get('editableByCustomer') === 'on',
    position: int(formData, 'position'),
    isActive: formData.get('isActive') !== 'off',
  };

  if (id) {
    // The key is deliberately not editable: every stored rule and every ticket's
    // custom_fields refers to it, and renaming it here would break both silently.
    await db.update(ticketFields).set(values).where(eq(ticketFields.id, id));
  } else {
    const existing = await db
      .select({ id: ticketFields.id })
      .from(ticketFields)
      .where(eq(ticketFields.key, key));
    if (existing.length) return { error: 'A field with that key already exists' };

    await db.insert(ticketFields).values({ ...values, key });
  }

  refresh('/admin/fields');
  return ok();
}

export async function deleteField(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');
  await db.delete(ticketFields).where(eq(ticketFields.id, text(formData, 'id')));
  refresh('/admin/fields');
  return ok();
}

// --- Canned responses -------------------------------------------------------

export async function saveCannedResponse(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');

  const id = text(formData, 'id');
  const title = text(formData, 'title');
  const bodyText = text(formData, 'bodyText');
  const folder = text(formData, 'folder') || null;

  if (!title) return { error: 'Give the response a title' };
  if (!bodyText) return { error: 'Write the response' };

  // Stored as both: email sends HTML, WhatsApp and the social channels send
  // text, and deriving one from the other at send time would mean every channel
  // guessing at line breaks.
  const bodyHtml = bodyText
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p>${paragraph
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>')}</p>`,
    )
    .join('\n');

  const values = { title, folder, bodyText, bodyHtml };

  if (id) {
    await db.update(cannedResponses).set(values).where(eq(cannedResponses.id, id));
  } else {
    await db.insert(cannedResponses).values(values);
  }

  refresh('/admin/canned');
  return ok();
}

export async function deleteCannedResponse(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');
  await db.delete(cannedResponses).where(eq(cannedResponses.id, text(formData, 'id')));
  refresh('/admin/canned');
  return ok();
}

// --- Business hours ---------------------------------------------------------

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export async function saveBusinessHours(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');

  const id = text(formData, 'id');
  const name = text(formData, 'name');
  const timezone = text(formData, 'timezone') || 'Africa/Cairo';

  if (!name) return { error: 'Give the schedule a name' };

  // An unknown zone would make every SLA due date null, and the failure would
  // show up days later as tickets that never breach.
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    return { error: `"${timezone}" is not a timezone this server recognises` };
  }

  const schedule = {} as WeeklySchedule;
  for (const day of DAYS) {
    const closed = formData.get(`${day}_closed`) === 'on';
    const start = text(formData, `${day}_start`);
    const end = text(formData, `${day}_end`);

    if (closed || !start || !end) {
      schedule[day] = [];
      continue;
    }

    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      return { error: `${day}: times must look like 09:00` };
    }
    if (end <= start) {
      return { error: `${day}: the closing time must be after the opening time` };
    }

    schedule[day] = [{ start, end }];
  }

  const isDefault = formData.get('isDefault') === 'on';

  await db.transaction(async (tx) => {
    if (isDefault) {
      await tx.update(businessHours).set({ isDefault: false });
    }

    if (id) {
      await tx
        .update(businessHours)
        .set({ name, timezone, schedule, isDefault, updatedAt: new Date() })
        .where(eq(businessHours.id, id));
    } else {
      await tx.insert(businessHours).values({ name, timezone, schedule, isDefault });
    }
  });

  refresh('/admin/hours');
  return ok();
}

export async function addHoliday(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');

  const businessHoursId = text(formData, 'businessHoursId');
  const date = text(formData, 'date');
  const name = text(formData, 'name');

  if (!businessHoursId) return { error: 'Pick a schedule' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date' };
  if (!name) return { error: 'Name the holiday' };

  await db.insert(holidays).values({ businessHoursId, date, name }).onConflictDoNothing();

  refresh('/admin/hours');
  return ok();
}

export async function deleteHoliday(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');
  await db.delete(holidays).where(eq(holidays.id, text(formData, 'id')));
  refresh('/admin/hours');
  return ok();
}

// --- SLA policies -----------------------------------------------------------

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

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

  const id = text(formData, 'id');
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
  const id = text(formData, 'id');

  // Tickets point at the policy for reporting; the column nulls out on delete,
  // which would quietly rewrite history. Deactivating keeps the record.
  const inUse = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversations)
    .where(eq(conversations.slaPolicyId, id));

  if ((inUse[0]?.count ?? 0) > 0) {
    await db.update(slaPolicies).set({ isActive: false }).where(eq(slaPolicies.id, id));
    refresh('/admin/sla');
    return {
      error: null,
      ok: true,
      nonce: Date.now(),
    };
  }

  await db.delete(slaPolicies).where(eq(slaPolicies.id, id));
  refresh('/admin/sla');
  return ok();
}

// --- Automation rules -------------------------------------------------------

export async function saveAutomationRule(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.automations');

  const id = text(formData, 'id');
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
  await db.delete(automationRules).where(eq(automationRules.id, text(formData, 'id')));
  refresh('/admin/automations');
  return ok();
}

export async function toggleAutomationRule(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.automations');

  const id = text(formData, 'id');
  const active = formData.get('active') === 'true';

  await db.update(automationRules).set({ isActive: active }).where(eq(automationRules.id, id));
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

  const id = String(formData.get('id') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  // Lowercased on write, because the unique index and every lookup compare the
  // canonical form — the same discipline contact_identities needs.
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const kind = String(formData.get('kind') ?? 'hub');
  const description = String(formData.get('description') ?? '').trim() || null;
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
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('internal_recipients_email_idx')) {
      return { error: 'Another recipient already uses that address' };
    }
    if (message.includes('internal_recipients_name_idx')) {
      return { error: 'Another recipient already has that name' };
    }
    throw error;
  }

  revalidatePath('/admin/recipients');
  return { ...OK, nonce: Date.now() };
}

export async function deleteInternalRecipient(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.channels');

  const id = String(formData.get('id') ?? '');

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
  return { ...OK, nonce: Date.now() };
}
