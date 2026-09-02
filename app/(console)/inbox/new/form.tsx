'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Field, Input, Select, Textarea } from '@/components/ui';
import { TicketFieldInput } from '@/components/ticket-field-input';
import { ACCEPT_ATTRIBUTE } from '@/lib/forms/files';
import {
  elementHelp,
  elementLabel,
  elementText,
  isRequired,
  SYSTEM_LABELS_EN,
  type FormElement,
  type InputElement,
} from '@/lib/forms/elements';
import { resolveVisibility, type SystemValues } from '@/lib/forms/visibility';
import {
  fieldLabel,
  type CustomFieldValues,
  type TicketFieldDef,
} from '@/lib/tickets/custom-fields';
import { createTicketFromForm, type ConsoleFormState } from './actions';

/**
 * Filling a form in for a customer who reached the team some other way.
 *
 * The same elements, the same visibility resolution and the same field inputs
 * the help centre uses — an agent should be answering the questions the
 * customer would have been asked, or the two paths produce tickets that no
 * report can compare.
 *
 * What differs is at the top: the agent says who the ticket is for. There is no
 * contact picker, deliberately — an email address is what every other ingest
 * path resolves on, so typing one joins the customer's existing history by the
 * same rule rather than by a second one that could disagree with it.
 */

const INITIAL: ConsoleFormState = { error: null };

export function ConsoleTicketForm({
  slug,
  elements,
  fields,
  defaultPriority,
}: {
  slug: string;
  /** Already narrowed to the agent's view — see `elementsFor`. */
  elements: FormElement[];
  fields: TicketFieldDef[];
  /** What the form would set if the agent does not touch the control. */
  defaultPriority: string | null;
}) {
  const [state, action] = useActionState(createTicketFromForm, INITIAL);
  const [custom, setCustom] = useState<CustomFieldValues>({});
  // Seeded, not left empty. The select rendered `value={value || 'medium'}`
  // while state stayed '', so the DOM submitted `medium` and the client's
  // visibility pass read `priority: null` — a question conditioned on priority
  // was never drawn and yet was treated as asked. It also meant every ticket
  // opened here landed at medium, silently overriding the form's own default.
  const [system, setSystem] = useState<SystemValues>(
    defaultPriority ? { priority: defaultPriority } : { priority: 'medium' },
  );
  const [fileCount, setFileCount] = useState(0);

  const byKey = new Map(fields.map((field) => [field.key, field]));

  const { visible } = resolveVisibility(elements, custom, {
    ...system,
    attachments: String(fileCount),
  });

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="slug" value={slug} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer email" hint="Joins their existing tickets, or starts a contact.">
          <Input name="requesterEmail" type="email" required autoFocus autoComplete="off" />
        </Field>
        <Field label="Customer name" hint="Only used if we do not know them yet.">
          <Input name="requesterName" autoComplete="off" />
        </Field>
      </div>

      {visible.map((element, index) => {
        if (element.kind === 'heading') {
          return (
            <h2 key={`h${index}`} className="mt-2 text-sm font-semibold">
              {elementText(element, 'en')}
            </h2>
          );
        }

        if (element.kind === 'note') {
          return (
            <p key={`n${index}`} className="text-sm text-[var(--muted-foreground)]">
              {elementText(element, 'en')}
            </p>
          );
        }

        const def = element.kind === 'field' ? (byKey.get(element.key) ?? null) : null;
        if (element.kind === 'field' && !def) return null;

        const fallback =
          element.kind === 'system' ? SYSTEM_LABELS_EN[element.key] : fieldLabel(def!, 'en');
        const label = elementLabel(element, fallback, 'en');
        const required = isRequired(element, def);
        const id = `q-${element.kind}-${element.key}`;

        return (
          <Field
            key={`${element.kind}:${element.key}`}
            label={required ? `${label} *` : label}
            as={def?.type === 'multi_select' || def?.type === 'checkbox' ? 'group' : 'label'}
            hint={elementHelp(element, 'en') ?? undefined}
          >
            {element.kind === 'system' ? (
              <SystemInput
                id={id}
                element={element}
                label={label}
                value={system[element.key] ?? ''}
                required={required}
                onChange={(value) => setSystem({ ...system, [element.key]: value })}
                onFiles={setFileCount}
              />
            ) : (
              <TicketFieldInput
                id={id}
                def={def!}
                locale="en"
                label={label}
                value={custom[def!.key]}
                required={required}
                invalid={false}
                onChange={(value) => setCustom({ ...custom, [def!.key]: value })}
                surface="console"
              />
            )}
          </Field>
        );
      })}

      <ErrorText>{state.error}</ErrorText>
      <Submit />
    </form>
  );
}

function SystemInput({
  id,
  element,
  label,
  value,
  required,
  onChange,
  onFiles,
}: {
  id: string;
  element: InputElement & { kind: 'system' };
  label: string;
  value: string;
  required: boolean;
  onChange: (value: string) => void;
  onFiles: (count: number) => void;
}) {
  const name = `system.${element.key}`;

  if (element.key === 'description') {
    return (
      <Textarea
        id={id}
        name={name}
        rows={6}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (element.key === 'attachments') {
    return (
      <input
        id={id}
        name="attachments"
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        onChange={(event) => onFiles(event.target.files?.length ?? 0)}
        className="w-full text-sm"
      />
    );
  }

  if (element.key === 'priority') {
    return (
      <Select id={id} name={name} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="urgent">Urgent</option>
      </Select>
    );
  }

  return (
    <Input
      id={id}
      name={name}
      maxLength={element.key === 'subject' ? 200 : 320}
      required={required}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="accent" disabled={pending} className="self-start">
      {pending ? 'Opening…' : 'Open ticket'}
    </Button>
  );
}
