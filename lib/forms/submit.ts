import { db } from '@/db/client';
import { conversationEvents, messages } from '@/db/schema';
import { normaliseEmail, looksLikeEmail } from '@/lib/auth/normalise';
import type { Locale } from '@/lib/kb/locale';
import { createTicket } from '@/lib/portal/tickets';
import { resolveContact } from '@/lib/tickets/contacts';
import { applyFieldValue } from '@/lib/tickets/custom-fields-parse';
import {
  fieldLabel,
  isBlank,
  type CustomFieldValues,
  type TicketFieldDef,
} from '@/lib/tickets/custom-fields';
import { storeFormAttachments } from './attachments';
import { checkFormFiles, type FileRefusal } from './files';
import {
  elementToken,
  elementsFor,
  isInput,
  isRequired,
  SYSTEM_KEYS,
  SYSTEM_LABELS_EN,
  type FormElement,
  type SystemKey,
  type Viewer,
} from './elements';
import { formName, type LoadedForm } from './queries';
import { renderSubject } from './subject';
import { renderAnswers } from './summary';
import { resolveVisibility, type SystemValues } from './visibility';

/**
 * Turning a submitted form into a ticket.
 *
 * One function for all three ways a form is filled in — a signed-in customer, a
 * visitor who is not, and an agent opening a ticket on somebody's behalf —
 * because the three differ only in who the requester is. Splitting them would
 * mean three places that each decide what "required" means and what a hidden
 * field's answer is worth, and the console's copy would be the one nobody
 * checked.
 *
 * Nothing here trusts the request about the form. The elements, the field
 * definitions and the visibility are all read from the database or computed from
 * the answers; the request supplies answers and nothing else.
 */

export type Requester =
  | { kind: 'session'; contactId: string }
  /** Identified by what the form itself asked for, plus an address for the log. */
  | { kind: 'anonymous'; ip: string | null }
  | { kind: 'agent'; contactId: string; agentId: string };

export type SubmitResult =
  | { ok: true; number: number; conversationId: string; attachmentsFailed: string[] }
  /**
   * The questions that were asked and not answered, as `kind:key`.
   *
   * Prefixed because a form may legitimately place both the built-in subject and
   * a custom field keyed `subject`, and a bare key would mark whichever input
   * the renderer matched first.
   */
  | { ok: false; reason: 'missing'; keys: string[] }
  /** The same, for answers a field's own rules refused. */
  | { ok: false; reason: 'invalid'; keys: string[] }
  /** An anonymous form that cannot tell who is writing. */
  | { ok: false; reason: 'requester' }
  | { ok: false; reason: 'files'; refusal: FileRefusal };

/** Where a system question's answer sits in the submitted form data. */
export function systemFieldName(key: SystemKey): string {
  return `system.${key}`;
}

/** Where a custom field's answer sits. Matches what the portal already used. */
export function customFieldName(key: string): string {
  return `custom.${key}`;
}

function readSystem(values: FormData, files: File[]): SystemValues {
  const system: SystemValues = {};

  for (const key of SYSTEM_KEYS) {
    if (key === 'attachments') {
      // A count, so `attachments gt 0` is expressible; there is nothing useful
      // to compare the bytes against.
      system.attachments = String(files.length);
      continue;
    }
    const raw = values.get(systemFieldName(key));
    if (typeof raw === 'string' && raw.trim()) system[key] = raw.trim();
  }

  return system;
}

/**
 * Every answer, parsed against the definition rather than against the request.
 *
 * The submitted keys say which answers were given; the definitions say which
 * fields exist, what type each is and what it will accept. Trusting the form for
 * that would let anybody store anything under any key — including one an
 * automation routes on.
 */
function readAnswers(
  values: FormData,
  elements: FormElement[],
  fields: TicketFieldDef[],
): { custom: CustomFieldValues; invalid: string[] } {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const invalid: string[] = [];
  let custom: CustomFieldValues = {};

  for (const element of elements) {
    if (element.kind !== 'field') continue;

    const def = byKey.get(element.key);
    if (!def) continue;

    const raw =
      def.type === 'multi_select'
        ? values.getAll(customFieldName(def.key)).map(String)
        : String(values.get(customFieldName(def.key)) ?? '');

    const applied = applyFieldValue(custom, def, raw);
    if (applied.ok) custom = applied.values;
    else invalid.push(def.key);
  }

  return { custom, invalid };
}

/**
 * Who the ticket belongs to.
 *
 * The anonymous branch resolves the claimed address onto whatever contact
 * already owns it, exactly as an inbound email does — that is what makes the
 * unified inbox real, and it is also the exposure: a web form has no SPF or
 * DKIM behind it, so a stranger can open a ticket that lands on a real
 * customer's record and shows up in their portal.
 *
 * The answer is not to confirm the address before creating the ticket, which
 * loses every customer who could not be bothered and which no helpdesk in this
 * category does. It is to say so on the ticket: `submitForm` writes an
 * `unverified_submitter` event carrying the claimed address and the client
 * address, and the console shows it, so an agent reads the ticket knowing
 * nobody proved who sent it.
 *
 * Two things this deliberately does not do. It does not pass a display name for
 * an address that already exists — `resolveContact` only sets one when it
 * creates the row, so a stranger cannot rename a known customer. And the
 * identity it may create is unverified, so it grants no portal sign-in.
 */
async function resolveRequester(
  requester: Requester,
  system: SystemValues,
): Promise<{ contactId: string; unverifiedEmail: string | null } | null> {
  if (requester.kind !== 'anonymous') {
    return { contactId: requester.contactId, unverifiedEmail: null };
  }

  const email = normaliseEmail(system.requester_email ?? '');
  if (!email || !looksLikeEmail(email)) return null;

  const resolved = await resolveContact({
    channel: 'email',
    identifier: email,
    displayName: system.requester_name ?? null,
  });

  return { contactId: resolved.contactId, unverifiedEmail: email };
}

export async function submitForm(input: {
  loaded: LoadedForm;
  values: FormData;
  requester: Requester;
  locale: Locale;
  /** A subject carried by the link that opened the form. See `renderSubject`. */
  subjectSeed?: string;
}): Promise<SubmitResult> {
  const { form, fields } = input.loaded;

  const viewer: Viewer = {
    audience: input.requester.kind === 'agent' ? 'agent' : 'customer',
    anonymous: input.requester.kind === 'anonymous',
  };

  // The same filter the page rendered with, so a question nobody was shown
  // cannot be answered by a request that claims it was.
  const offered = elementsFor(form.elements, viewer, fields);

  // Files are an answer like any other, so they go through the same gate. Read
  // only when the form asks for them at all: without this, a form with no
  // attachment question still accepted and stored whatever a hand-made request
  // carried — an unauthenticated write to the bucket on the one path designed so
  // that a file cannot exist without the ticket explaining it.
  const asksFiles = offered.some(
    (element) => element.kind === 'system' && element.key === 'attachments',
  );

  const checked = asksFiles
    ? checkFormFiles(input.values.getAll('attachments'))
    : ({ ok: true, files: [] as File[] } as const);
  if (!checked.ok) return { ok: false, reason: 'files', refusal: checked.refusal };

  const submitted = readAnswers(input.values, offered, fields);
  const system = readSystem(input.values, checked.files);

  // The second computation of visibility, and the one that counts: the browser's
  // answer arrived as a POST anybody can write by hand.
  const resolved = resolveVisibility(offered, submitted.custom, system);
  const asked = new Set(resolved.visible.filter(isInput).map(elementToken));

  const byKey = new Map(fields.map((field) => [field.key, field]));

  // Reported only for questions that were actually asked. A field the conditions
  // never revealed cannot be wrong, and refusing over one would show an error
  // beside an input that is not on screen.
  const invalid = submitted.invalid
    .map((key) => `field:${key}`)
    .filter((token) => asked.has(token));
  if (invalid.length) return { ok: false, reason: 'invalid', keys: invalid };

  const missing: string[] = [];
  for (const element of resolved.visible) {
    if (!isInput(element)) continue;

    const def = element.kind === 'field' ? (byKey.get(element.key) ?? null) : null;
    if (!isRequired(element, def)) continue;

    const answered =
      element.kind === 'field'
        ? !isBlank(resolved.custom[element.key])
        : element.key === 'attachments'
          ? checked.files.length > 0
          : Boolean(resolved.system[element.key]);

    if (!answered) missing.push(elementToken(element));
  }
  if (missing.length) return { ok: false, reason: 'missing', keys: missing };

  const requester = await resolveRequester(input.requester, resolved.system);
  if (!requester) return { ok: false, reason: 'requester' };

  const placedFields = resolved.visible.filter(
    (element): element is Extract<FormElement, { kind: 'field' }> => element.kind === 'field',
  );

  const subject = renderSubject(
    form.subjectTemplate,
    placedFields,
    fields,
    resolved.custom,
    resolved.system,
    input.locale,
    formName(form, input.locale),
    input.subjectSeed ?? '',
  );

  // The answers go into the message as well as into `custom_fields`, because the
  // message is where a ticket is read and the sidebar is where it is edited.
  const answers = renderAnswers(resolved.visible, fields, resolved.custom, input.locale);
  const description = (resolved.system.description ?? '').trim();
  const body = [description, answers].filter(Boolean).join('\n\n');

  const created = await createTicket(requester.contactId, {
    subject,
    body,
    customFields: resolved.custom,
    formId: form.id,
    groupId: form.defaultGroupId,
    priority: priorityFrom(resolved.system) ?? form.defaultPriority,
    type: form.defaultType,
    tags: form.defaultTags,
  });

  if (input.requester.kind === 'agent') {
    // Recorded because `ticket.create` is justified as a reporting-integrity
    // permission — "every ticket an agent opens counts in first-response time,
    // in volume per channel". Nothing distinguished those tickets, so the
    // integrity the permission protects was unmeasurable.
    await db.insert(conversationEvents).values({
      conversationId: created.conversationId,
      type: 'opened_by_agent',
      actorAgentId: input.requester.agentId,
      data: { form: form.slug },
    });
  }

  if (requester.unverifiedEmail) {
    await db.insert(conversationEvents).values({
      conversationId: created.conversationId,
      type: 'unverified_submitter',
      actorLabel: 'form',
      data: {
        email: requester.unverifiedEmail,
        form: form.slug,
        ip: input.requester.kind === 'anonymous' ? input.requester.ip : null,
      },
    });
  }

  // And discarded outright when the question turned out not to be asked — the
  // element can be behind a condition that did not fire, in which case the files
  // are an answer to something nobody was shown.
  const filesAsked = resolved.visible.some(
    (element) => element.kind === 'system' && element.key === 'attachments',
  );
  const files = filesAsked ? checked.files : [];

  const attachmentsFailed = files.length
    ? (await storeFormAttachments({ ...created, files })).failed
    : [];

  if (attachmentsFailed.length) {
    // On the ticket, not only in a worker log. The customer is told their file
    // did not arrive; the agent has to be told the same thing or the two of them
    // are looking at different tickets — and "silent success is worse than a
    // failure" is exactly this case.
    await db.insert(messages).values({
      conversationId: created.conversationId,
      direction: 'inbound',
      kind: 'system',
      bodyText: `Could not store ${attachmentsFailed.join(', ')} — ask the customer to send it again.`,
      deliveryStatus: 'delivered',
    });
  }

  return {
    ok: true,
    number: created.number,
    conversationId: created.conversationId,
    attachmentsFailed,
  };
}

/** Only an agent is offered the control, and only the four real values count. */
function priorityFrom(system: SystemValues): 'low' | 'medium' | 'high' | 'urgent' | null {
  const value = system.priority;
  return value === 'low' || value === 'medium' || value === 'high' || value === 'urgent'
    ? value
    : null;
}

/** The labels of the questions a submission left unanswered, for an agent's error. */
export function labelsFor(tokens: string[], fields: TicketFieldDef[], locale: Locale): string[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));

  return tokens.map((token) => {
    const [kind, ...rest] = token.split(':');
    const key = rest.join(':');

    // Without this the console asked an agent to "Fill in description" — the
    // only lookup here was the custom fields, and a built-in question is not one.
    if (kind === 'system') return SYSTEM_LABELS_EN[key as SystemKey] ?? key;

    const def = byKey.get(key);
    return def ? fieldLabel(def, locale) : key;
  });
}
