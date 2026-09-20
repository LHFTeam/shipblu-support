'use server';

import { revalidatePath } from 'next/cache';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agents,
  agentSkills,
  autoResponses,
  automationRules,
  businessHours,
  cannedResponses,
  holidays,
  locations,
  slaPolicies,
  ticketFields,
  ticketForms,
  ticketStatuses,
  groups,
  conversations,
  internalRecipients,
  sideConversations,
  skills,
  channels,
  whatsappAccounts,
  shipmentPhrases,
} from '@/db/schema';
import type { SlaTargets, TicketFieldValidation, WeeklySchedule } from '@/db/schema/config';
import { requirePermission } from '@/lib/auth/guard';
import { textToHtml } from '@/lib/html/sanitize';
import { looksLikeEmail, normaliseEmail } from '@/lib/auth/normalise';
import { parseActions } from '@/lib/automations/actions';
import {
  isValidLocationCode,
  normaliseLocationCode,
  LOCATION_CODE_MAX,
} from '@/lib/locations/format';
import { parseFormElements } from '@/lib/forms/elements';
import { forgetHoursCatalog } from '@/lib/hours/catalog';
import { formsUsingField } from '@/lib/forms/queries';
import { slugify } from '@/lib/kb/slug';
import { parseCondition } from '@/lib/rules/conditions';
import { parseOptionLines, type TicketFieldDef } from '@/lib/tickets/custom-fields';
import { listAllTicketFields } from '@/lib/tickets/queries';
import { PHRASE_GROUPS } from '@/lib/shipments/status';
import { parseTokenEnvVar } from '@/lib/whatsapp/accounts';
import { validatePolicy } from '@/lib/presence/idle';
import { savePresencePolicy } from '@/lib/presence/policy';

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
  // Same reason as `saveGroup`, and the easier one to forget: the catalogue
  // holds `groups.business_hours_id` as its override map, so a deleted group
  // that carried a schedule keeps resolving to it for the rest of the TTL, and
  // any due date computed in that window comes from a row that is gone.
  forgetHoursCatalog();
  return ok();
}

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

  const options = parseOptionLines(text(formData, 'options'));

  const validation = readValidation(formData);
  if (!validation.ok) return { error: validation.error };

  const values = {
    label,
    labelAr: text(formData, 'labelAr') || null,
    labelEn: text(formData, 'labelEn') || null,
    type: type as (typeof FIELD_TYPES)[number],
    options,
    validation: validation.rules,
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

/**
 * A number the admin typed, or null. Rejects the shapes a number input still
 * lets through — an empty box is "no rule", `abc` is a mistake worth naming.
 */
function optionalNumber(
  formData: FormData,
  key: string,
): { ok: true; value: number | null } | null {
  const raw = text(formData, key);
  if (!raw) return { ok: true, value: null };
  const value = Number(raw);
  return Number.isFinite(value) ? { ok: true, value } : null;
}

/** An admin's regular expression is compiled here so a broken one never ships. */
const MAX_PATTERN = 200;

function readValidation(
  formData: FormData,
): { ok: true; rules: TicketFieldValidation | null } | { ok: false; error: string } {
  const pattern = text(formData, 'pattern');

  if (pattern.length > MAX_PATTERN) {
    return { ok: false, error: `Keep the pattern under ${MAX_PATTERN} characters` };
  }
  if (pattern) {
    try {
      new RegExp(pattern, 'u');
    } catch {
      // Caught here rather than at submit time, where the parser deliberately
      // skips a pattern it cannot compile: a rule that refuses nothing is worse
      // than one that never saved.
      return { ok: false, error: 'That pattern is not a valid regular expression' };
    }
  }

  const numbers: Record<string, number | null> = {};
  for (const key of ['min', 'max', 'minLength', 'maxLength']) {
    const parsed = optionalNumber(formData, key);
    if (!parsed) return { ok: false, error: `${key} must be a number` };
    numbers[key] = parsed.value;
  }

  if (numbers.min !== null && numbers.max !== null && numbers.min! > numbers.max!) {
    return { ok: false, error: 'The smallest value cannot be larger than the largest' };
  }
  if (
    numbers.minLength !== null &&
    numbers.maxLength !== null &&
    numbers.minLength! > numbers.maxLength!
  ) {
    return { ok: false, error: 'The shortest length cannot be longer than the longest' };
  }

  const rules: TicketFieldValidation = {};
  if (pattern) rules.pattern = pattern;
  const patternMessageAr = text(formData, 'patternMessageAr');
  const patternMessageEn = text(formData, 'patternMessageEn');
  if (patternMessageAr) rules.patternMessageAr = patternMessageAr;
  if (patternMessageEn) rules.patternMessageEn = patternMessageEn;
  for (const key of ['min', 'max', 'minLength', 'maxLength'] as const) {
    if (numbers[key] !== null) rules[key] = numbers[key]!;
  }

  // Null rather than `{}` so "this field has no extra rules" is one value, not
  // two that read differently in a jsonb dump.
  return { ok: true, rules: Object.keys(rules).length ? rules : null };
}

export async function deleteField(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.fields');

  const rows = await db
    .select({ key: ticketFields.key })
    .from(ticketFields)
    .where(eq(ticketFields.id, text(formData, 'id')))
    .limit(1);

  const key = rows[0]?.key;
  if (!key) return ok();

  // A form naming a field that is gone renders one question fewer, silently.
  // That is the right runtime behaviour — see `parseFormElements` — and the
  // wrong thing to let somebody do by accident from a screen that says nothing.
  const used = await formsUsingField(key);
  if (used.length) {
    return {
      error: `Still asked by ${used.join(', ')}. Remove it from ${
        used.length === 1 ? 'that form' : 'those forms'
      } first, or deactivate the field instead — deactivating keeps every answer already given.`,
    };
  }

  await db.delete(ticketFields).where(eq(ticketFields.id, text(formData, 'id')));
  refresh('/admin/fields');
  return ok();
}

// --- Ticket forms -----------------------------------------------------------

/**
 * Which entries `parseFormElements` threw away, by position.
 *
 * "1 of 8 questions could not be saved" tells an admin that something is wrong
 * and nothing about where, on a screen where the offending row often renders
 * blank precisely because it is the broken one. Re-parsing each prefix is O(n²)
 * on an array of a dozen, and it is exact — including for a duplicate, which is
 * only droppable in the context of the entries before it.
 */
function droppedPositions(document: unknown[], fields: TicketFieldDef[]): number[] {
  const dropped: number[] = [];
  let kept = 0;

  for (let index = 0; index < document.length; index += 1) {
    const size = parseFormElements(document.slice(0, index + 1), fields).length;
    if (size === kept) dropped.push(index + 1);
    kept = size;
  }

  return dropped;
}

/** "3", "3 and 5", "3, 5 and 9". */
function listPositions(positions: number[]): string {
  if (positions.length <= 1) return positions.join('');
  return `${positions.slice(0, -1).join(', ')} and ${positions[positions.length - 1]}`;
}

/**
 * Saves a form, storing the layout **as parsed** rather than as submitted.
 *
 * The builder posts the whole document in one hidden input so the server
 * validates exactly what will be stored — the same shape the condition and
 * action builders use. Writing back the parsed value rather than the raw one
 * closes the last gap in that: what is in the column is then literally what
 * `parseFormElements` will hand the renderer, with visibility defaulted and
 * blank overrides normalised, so the form on screen and the form in the
 * database cannot be two different documents.
 */
export async function saveTicketForm(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.forms');

  const id = text(formData, 'id');
  const nameEn = text(formData, 'nameEn');
  const nameAr = text(formData, 'nameAr');

  // One language is enough, deliberately: a team that works in Arabic should not
  // have to invent an English name to publish a form. `localised` shows whichever
  // exists to everybody.
  if (!nameEn && !nameAr) return { error: 'Give the form a name in at least one language' };

  // Through `lib/kb/slug.ts`, never an ASCII slugify — Arabic is the default
  // locale and the front door, and an ASCII slugify erases an Arabic name
  // entirely, leaving every form called the same empty string.
  const slug = slugify(text(formData, 'slug') || nameEn || nameAr, '');
  if (!slug) return { error: 'That name has no characters a web address can carry — set a slug' };

  let document: unknown;
  try {
    document = JSON.parse(text(formData, 'elements') || '[]');
  } catch {
    return { error: 'The form layout is not valid JSON' };
  }
  if (!Array.isArray(document)) return { error: 'The form layout has to be a list of questions' };

  // Every field, not just the active ones. A deactivated field is one an admin
  // retired, and parsing against the active list here would make every form that
  // still places it refuse to save — including a save that only fixed a typo in
  // the intro, with a message about a question the admin could no longer see.
  const fields = await listAllTicketFields();
  const elements = parseFormElements(document, fields);

  // Loud rather than lossy. `parseFormElements` drops what it cannot understand
  // because a live form must keep rendering, but a save that silently discards
  // three questions is how an admin finds out weeks later that the form stopped
  // asking about the warehouse.
  if (elements.length !== document.length) {
    const dropped = droppedPositions(document, fields);
    return {
      error: `Could not save question ${listPositions(dropped)} — a question with nothing chosen, with no text, naming a field that no longer exists, repeating one already on the form, or with a condition that cannot be read.`,
    };
  }

  const requiresSignIn = formData.get('requiresSignIn') === 'on';
  const asksEmail = elements.some(
    (element) => element.kind === 'system' && element.key === 'requester_email',
  );
  if (!requiresSignIn && !asksEmail) {
    return {
      error:
        'A form anybody can submit has to ask for an email address, or nothing can be replied to. Add the email question, or require signing in.',
    };
  }

  const defaultGroupId = text(formData, 'defaultGroupId') || null;
  if (defaultGroupId) {
    const exists = await db
      .select({ id: groups.id })
      .from(groups)
      .where(eq(groups.id, defaultGroupId))
      .limit(1);
    // Surfaces as a sentence rather than as a foreign-key violation, which is
    // what an admin gets if the group was deleted while this screen was open.
    if (!exists.length) return { error: 'That group no longer exists' };
  }

  const priority = text(formData, 'defaultPriority');
  const values = {
    slug,
    nameAr,
    nameEn,
    descriptionAr: text(formData, 'descriptionAr'),
    descriptionEn: text(formData, 'descriptionEn'),
    elements,
    requiresSignIn,
    showOnHelpCentre: formData.get('showOnHelpCentre') === 'on',
    showInConsole: formData.get('showInConsole') === 'on',
    defaultGroupId,
    defaultPriority: PRIORITIES.includes(priority as (typeof PRIORITIES)[number])
      ? (priority as (typeof PRIORITIES)[number])
      : null,
    defaultType: text(formData, 'defaultType') || null,
    defaultTags: text(formData, 'defaultTags')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    subjectTemplate: text(formData, 'subjectTemplate') || null,
    confirmationAr: text(formData, 'confirmationAr'),
    confirmationEn: text(formData, 'confirmationEn'),
    position: int(formData, 'position'),
    isActive: formData.get('isActive') !== 'off',
    updatedAt: new Date(),
  };

  const clash = await db
    .select({ id: ticketForms.id })
    .from(ticketForms)
    .where(
      id ? and(eq(ticketForms.slug, slug), ne(ticketForms.id, id)) : eq(ticketForms.slug, slug),
    )
    .limit(1);
  if (clash.length) return { error: `Another form already lives at /${slug}` };

  if (id) await db.update(ticketForms).set(values).where(eq(ticketForms.id, id));
  else await db.insert(ticketForms).values(values);

  refresh('/admin/forms');
  return ok();
}

/**
 * Deleting a form is refused while a ticket points at it.
 *
 * The column is `on delete set null`, so the delete would succeed and quietly
 * erase where every one of those tickets came from — which is the one thing
 * `conversations.form_id` exists to remember. Deactivating takes the form off
 * the help centre and keeps the history, which is what "delete" almost always
 * meant.
 */
export async function deleteTicketForm(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.forms');

  const id = text(formData, 'id');

  const used = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.formId, id))
    .limit(1);

  if (used.length) {
    return {
      error:
        'Tickets were opened through this form. Deactivate it instead — that takes it off the help centre and keeps the record of where those tickets came from.',
    };
  }

  await db.delete(ticketForms).where(eq(ticketForms.id, id));
  refresh('/admin/forms');
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
  const bodyTextAr = text(formData, 'bodyTextAr');
  const bodyTextEn = text(formData, 'bodyTextEn');
  const folder = text(formData, 'folder') || null;

  if (!title) return { error: 'Give the response a title' };

  // One language is a complete response; neither is a row nothing can send. The
  // form asks for both and requires neither, so this is where the real rule is.
  if (!bodyTextAr && !bodyTextEn) return { error: 'Write the response in at least one language' };

  // Stored as both forms: email sends HTML, WhatsApp and the social channels
  // send text, and deriving one from the other at send time would mean every
  // channel guessing at line breaks. An unwritten language stays empty in both
  // — `textToHtml('')` would otherwise leave markup that reads as a body.
  const bodyHtmlAr = bodyTextAr ? textToHtml(bodyTextAr) : '';
  const bodyHtmlEn = bodyTextEn ? textToHtml(bodyTextEn) : '';

  const values = {
    title,
    folder,
    bodyTextAr,
    bodyHtmlAr,
    bodyTextEn,
    bodyHtmlEn,
    /*
      The superseded pair, written for as long as it still exists.

      `db/schema/config.ts` keeps these columns through one release because the
      worker and the four crons deploy separately from the service that runs the
      migration, and the old `sendCannedReply` selects them. That only buys
      anything if they still say something: a response created after the
      migration and never written here is `''` to the old code, which sends a
      customer an empty automated reply rather than falling back to anything.
      Arabic first, for the reason `DEFAULT_LOCALE` is — a single body can only
      answer one half of the queue, and this is the larger half.

      Goes when the columns do; `docs/PROJECT-STATE.md` §5.5 carries the removal.
    */
    bodyText: bodyTextAr || bodyTextEn,
    bodyHtml: bodyHtmlAr || bodyHtmlEn,
  };

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

// --- Out-of-hours auto-responses --------------------------------------------

/**
 * The channel values a rule may be scoped to.
 *
 * Read from the form and checked against this list rather than cast, because
 * the column is an enum: an unknown value is a Postgres error at write time,
 * and the error a customer-facing setting deserves is "pick a channel", not a
 * 500 in the log.
 *
 * `whatsapp_bot` is deliberately absent. Nothing is ever sent on it — the bot
 * owns those conversations — so offering it would be offering a setting that
 * cannot do anything.
 */
const AUTO_RESPONSE_CHANNELS = [
  'email',
  'whatsapp',
  'webchat',
  'facebook',
  'instagram',
  'portal',
] as const;

type AutoResponseChannel = (typeof AUTO_RESPONSE_CHANNELS)[number];

function autoResponseChannel(formData: FormData): AutoResponseChannel | null | undefined {
  const raw = text(formData, 'channel');
  if (!raw) return null;
  return (AUTO_RESPONSE_CHANNELS as readonly string[]).includes(raw)
    ? (raw as AutoResponseChannel)
    : undefined;
}

export async function saveAutoResponse(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.automations');

  const id = text(formData, 'id');
  const groupId = text(formData, 'groupId') || null;
  const channel = autoResponseChannel(formData);
  if (channel === undefined) return { error: 'Pick a channel, or leave it on every channel' };

  const silent = formData.get('silent') === 'on';
  const bodyAr = text(formData, 'bodyAr');
  const bodyEn = text(formData, 'bodyEn');

  // A rule that is neither silent nor written sends nothing, which is the same
  // as not existing — except that it also shadows the broader rule that would
  // have answered. Better refused at the form than debugged at midnight.
  if (!silent && !bodyAr && !bodyEn) {
    return { error: 'Write the message in at least one language, or tick “send nothing”' };
  }

  const values = {
    groupId,
    channel,
    silent,
    bodyAr,
    bodyEn,
    holidayBodyAr: text(formData, 'holidayBodyAr'),
    holidayBodyEn: text(formData, 'holidayBodyEn'),
    isActive: formData.get('isActive') === 'on',
    updatedAt: new Date(),
  };

  // The scope is the identity, so a duplicate is a constraint violation rather
  // than a second row: caught here to say which rule already covers it, because
  // the raw error names a constraint the admin has never heard of.
  const clash = await db
    .select({ id: autoResponses.id })
    .from(autoResponses)
    .where(
      and(
        groupId ? eq(autoResponses.groupId, groupId) : isNull(autoResponses.groupId),
        channel ? eq(autoResponses.channel, channel) : isNull(autoResponses.channel),
        id ? ne(autoResponses.id, id) : undefined,
      ),
    )
    .limit(1);

  if (clash[0]) {
    return { error: 'A rule already covers that group and channel — edit it instead' };
  }

  if (id) {
    await db.update(autoResponses).set(values).where(eq(autoResponses.id, id));
  } else {
    await db.insert(autoResponses).values(values);
  }

  refresh('/admin/auto-responses');
  return ok();
}

export async function deleteAutoResponse(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.automations');
  await db.delete(autoResponses).where(eq(autoResponses.id, text(formData, 'id')));
  refresh('/admin/auto-responses');
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

  // The catalogue is memoised for thirty seconds and a due date is computed
  // from it, so the process that took the edit drops its copy now rather than
  // serving a stale schedule to the next SLA calculation.
  forgetHoursCatalog();
  refresh('/admin/hours');
  return ok();
}

/**
 * Add a holiday, or correct one that is already on the calendar.
 *
 * Editing exists because the name is now the part most likely to be wrong — it
 * reaches a customer through `{{holiday}}`, and it is typed twice, in two
 * scripts. Before this the only way to change it was to delete the row and add
 * it again, which is not a repair anybody guesses at.
 *
 * A duplicate date is **refused rather than ignored.** The insert used to be
 * `onConflictDoNothing()` followed by `ok()`, so retyping a date the calendar
 * already had reported success and changed nothing — the one shape of failure
 * this codebase calls worse than an error, and it landed on exactly the person
 * trying to fix a name. The insert keeps the conflict clause so a race cannot
 * raise instead, and an insert that touched no row is now the error message.
 */
export async function saveHoliday(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');

  const id = text(formData, 'id');
  const date = text(formData, 'date');
  const nameAr = text(formData, 'nameAr');
  const nameEn = text(formData, 'nameEn');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date' };

  // One name is enough — `holidayName` falls back to whichever was written —
  // but a holiday with neither leaves `{{holiday}}` empty in an out-of-hours
  // message that only exists to say which day it is.
  if (!nameAr && !nameEn) return { error: 'Name the holiday in at least one language' };

  const taken = 'That schedule already has a holiday on that date';

  /*
    The superseded single name, written for as long as the column exists.

    Same reason as `saveCannedResponse`: only the two web services run
    `db:migrate`, and `loadHoursCatalog` on the still-old worker and crons
    selects `holidays.name`. Leaving it at its default would mean a holiday added
    today closes the office correctly on old code and interpolates nothing into
    `{{holiday}}` — a message whose whole job is naming the day. Arabic first,
    like the canned pair. Goes when the column does.
  */
  const name = nameAr || nameEn;

  if (id) {
    // The schedule comes from the stored row, never from the form: the hidden
    // field is a claim by whoever posted it, and honouring it would let one
    // move a holiday onto a calendar the page never showed.
    const existing = await db
      .select({ businessHoursId: holidays.businessHoursId })
      .from(holidays)
      .where(eq(holidays.id, id))
      .limit(1);

    const row = existing[0];
    if (!row) return { error: 'That holiday has already been removed' };

    // Moving a holiday onto a date its own calendar already uses. Checked
    // rather than left to the unique index, which would surface as a 500.
    const clash = await db
      .select({ id: holidays.id })
      .from(holidays)
      .where(
        and(
          eq(holidays.businessHoursId, row.businessHoursId),
          eq(holidays.date, date),
          ne(holidays.id, id),
        ),
      )
      .limit(1);

    if (clash.length > 0) return { error: taken };

    await db.update(holidays).set({ date, nameAr, nameEn, name }).where(eq(holidays.id, id));
  } else {
    const businessHoursId = text(formData, 'businessHoursId');
    if (!businessHoursId) return { error: 'Pick a schedule' };

    const inserted = await db
      .insert(holidays)
      .values({ businessHoursId, date, nameAr, nameEn, name })
      .onConflictDoNothing()
      .returning({ id: holidays.id });

    if (inserted.length === 0) return { error: taken };
  }

  // The catalogue is memoised for thirty seconds and a due date is computed
  // from it, so the process that took the edit drops its copy now rather than
  // serving a stale schedule to the next SLA calculation.
  forgetHoursCatalog();
  refresh('/admin/hours');
  return ok();
}

export async function deleteHoliday(
  _state: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  await requirePermission('admin.sla');
  await db.delete(holidays).where(eq(holidays.id, text(formData, 'id')));
  // The catalogue is memoised for thirty seconds and a due date is computed
  // from it, so the process that took the edit drops its copy now rather than
  // serving a stale schedule to the next SLA calculation.
  forgetHoursCatalog();
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

  const id = text(formData, 'id');
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
  const id = text(formData, 'id');
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

  const id = text(formData, 'id');
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

  const id = String(formData.get('id') ?? '');

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
