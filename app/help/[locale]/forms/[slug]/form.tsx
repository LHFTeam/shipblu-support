'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Input, Label, Textarea } from '@/components/ui';
import { ACCEPT_ATTRIBUTE, MAX_FORM_FILES } from '@/lib/forms/files';
import {
  elementHelp,
  elementLabel,
  elementText,
  isRequired,
  type FormElement,
  type InputElement,
  type SystemKey,
} from '@/lib/forms/elements';
import { resolveVisibility, type SystemValues } from '@/lib/forms/visibility';
import { t, tCount, type Locale, type StringKey } from '@/lib/kb/locale';
import {
  fieldLabel,
  localised,
  optionLabel,
  selectedValues,
  type CustomFieldValues,
  type TicketFieldDef,
} from '@/lib/tickets/custom-fields';
import { submitTicketForm, type FormSubmitState } from '../actions';

/**
 * A ticket form, as a customer fills it in.
 *
 * Controlled rather than uncontrolled, which the portal's older form is not,
 * and the reason is conditional questions: a question that appears the moment
 * another is answered needs the answers in React's hands. The visibility it
 * renders comes from `resolveVisibility` — the same function the server runs
 * again on submit, so what is on screen and what will be accepted are one
 * definition rather than two that drift.
 */

const INITIAL: FormSubmitState = { error: null };

const SYSTEM_LABELS: Record<SystemKey, StringKey> = {
  subject: 'subject',
  description: 'message',
  attachments: 'attachments',
  requester_name: 'yourName',
  requester_email: 'yourEmail',
  priority: 'priority',
};

const PRIORITIES: { value: string; label: StringKey }[] = [
  { value: 'low', label: 'priorityLow' },
  { value: 'medium', label: 'priorityMedium' },
  { value: 'high', label: 'priorityHigh' },
  { value: 'urgent', label: 'priorityUrgent' },
];

export function TicketForm({
  locale,
  slug,
  elements,
  fields,
  subject = '',
}: {
  locale: Locale;
  slug: string;
  /** Already narrowed to what this viewer is asked — see `elementsFor`. */
  elements: FormElement[];
  fields: TicketFieldDef[];
  /** Seeded from the query string, the way the tracking page hands over a number. */
  subject?: string;
}) {
  const [state, action] = useActionState(submitTicketForm, INITIAL);
  const [custom, setCustom] = useState<CustomFieldValues>({});
  const [system, setSystem] = useState<SystemValues>(subject ? { subject } : {});
  const [fileCount, setFileCount] = useState(0);

  const byKey = new Map(fields.map((field) => [field.key, field]));

  const { visible } = resolveVisibility(elements, custom, {
    ...system,
    attachments: String(fileCount),
  });

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="slug" value={slug} />

      {visible.map((element, index) => {
        if (element.kind === 'heading') {
          return (
            <h2 key={`h${index}`} className="mt-2 text-base font-semibold text-[var(--kb-heading)]">
              {elementText(element, locale)}
            </h2>
          );
        }

        if (element.kind === 'note') {
          return (
            <p key={`n${index}`} className="text-sm text-[var(--kb-muted)]">
              {elementText(element, locale)}
            </p>
          );
        }

        const def = element.kind === 'field' ? (byKey.get(element.key) ?? null) : null;
        if (element.kind === 'field' && !def) return null;

        return (
          <Question
            key={`${element.kind}:${element.key}`}
            locale={locale}
            element={element}
            def={def}
            custom={custom}
            system={system}
            missing={state.missing?.includes(element.key) ?? false}
            invalid={state.invalid?.includes(element.key) ?? false}
            onCustom={(value) => setCustom({ ...custom, [element.key]: value })}
            onSystem={(value) => setSystem({ ...system, [element.key as SystemKey]: value })}
            onFiles={setFileCount}
          />
        );
      })}

      <ErrorText>{state.error ? errorText(locale, state.error) : null}</ErrorText>

      <Submit locale={locale} />
    </form>
  );
}

/** The one error whose sentence carries a number the form itself decides. */
function errorText(locale: Locale, key: StringKey): string {
  return key === 'errorTooManyFiles' ? tCount(locale, key, MAX_FORM_FILES) : t(locale, key);
}

function Question({
  locale,
  element,
  def,
  custom,
  system,
  missing,
  invalid,
  onCustom,
  onSystem,
  onFiles,
}: {
  locale: Locale;
  element: InputElement;
  def: TicketFieldDef | null;
  custom: CustomFieldValues;
  system: SystemValues;
  missing: boolean;
  invalid: boolean;
  onCustom: (value: unknown) => void;
  onSystem: (value: string) => void;
  onFiles: (count: number) => void;
}) {
  const fallback =
    element.kind === 'system' ? t(locale, SYSTEM_LABELS[element.key]) : fieldLabel(def!, locale);

  const label = elementLabel(element, fallback, locale);
  const help = elementHelp(element, locale);
  const id = `q-${element.kind}-${element.key}`;
  const required = isRequired(element, def);

  // A checkbox is answered by either state, so `required` on it would mean "must
  // tick", which is a consent control and a different feature.
  const mark = required && def?.type !== 'checkbox';

  const message = invalid
    ? localised(
        def?.validation?.patternMessageAr,
        def?.validation?.patternMessageEn,
        locale,
        t(locale, 'errorInvalidFields'),
      )
    : null;

  return (
    <div>
      {def?.type === 'checkbox' ? null : (
        <Label htmlFor={id}>
          {label}
          {mark ? <span aria-hidden="true"> *</span> : null}
          {!required && element.kind === 'field' ? (
            <span className="ms-1 font-normal">({t(locale, 'optional')})</span>
          ) : null}
        </Label>
      )}

      {element.kind === 'system' ? (
        <SystemInput
          id={id}
          element={element}
          locale={locale}
          label={label}
          value={system[element.key] ?? ''}
          required={required}
          invalid={missing}
          onChange={onSystem}
          onFiles={onFiles}
        />
      ) : (
        <FieldInput
          id={id}
          def={def!}
          locale={locale}
          label={label}
          value={custom[def!.key]}
          required={required}
          invalid={missing || invalid}
          onChange={onCustom}
        />
      )}

      {help ? <p className="mt-1 text-xs text-[var(--kb-muted)]">{help}</p> : null}
      {message ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">{message}</p> : null}
    </div>
  );
}

function SystemInput({
  id,
  element,
  locale,
  label,
  value,
  required,
  invalid,
  onChange,
  onFiles,
}: {
  id: string;
  element: InputElement & { kind: 'system' };
  locale: Locale;
  label: string;
  value: string;
  required: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
  onFiles: (count: number) => void;
}) {
  const name = `system.${element.key}`;

  if (element.key === 'description') {
    return (
      <Textarea
        id={id}
        name={name}
        rows={8}
        required={required}
        aria-invalid={invalid}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (element.key === 'attachments') {
    return (
      <>
        <input
          id={id}
          name="attachments"
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          onChange={(event) => onFiles(event.target.files?.length ?? 0)}
          className="w-full text-sm"
        />
        <p className="mt-1 text-xs text-[var(--kb-muted)]">
          {tCount(locale, 'attachmentsHint', MAX_FORM_FILES)}
        </p>
      </>
    );
  }

  if (element.key === 'priority') {
    return (
      <select
        id={id}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-[var(--kb-border)] bg-transparent px-3 py-2 text-sm"
      >
        {PRIORITIES.map((priority) => (
          <option key={priority.value} value={priority.value}>
            {t(locale, priority.label)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Input
      id={id}
      name={name}
      type={element.key === 'requester_email' ? 'email' : 'text'}
      autoComplete={
        element.key === 'requester_email'
          ? 'email'
          : element.key === 'requester_name'
            ? 'name'
            : undefined
      }
      maxLength={element.key === 'subject' ? 200 : 320}
      required={required}
      aria-invalid={invalid}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function FieldInput({
  id,
  def,
  locale,
  label,
  value,
  required,
  invalid,
  onChange,
}: {
  id: string;
  def: TicketFieldDef;
  locale: Locale;
  label: string;
  value: unknown;
  required: boolean;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const name = `custom.${def.key}`;
  // `required` and `pattern` are set on the input as well as checked on the
  // server. The attribute is the fast answer that never reaches the network;
  // the server check is the one that is true.
  const mark = required && def.type !== 'checkbox';
  const text = typeof value === 'string' ? value : '';

  if (def.type === 'paragraph') {
    return (
      <Textarea
        id={id}
        name={name}
        rows={4}
        required={mark}
        aria-invalid={invalid}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (def.type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          name={name}
          className="size-4"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    );
  }

  if (def.type === 'dropdown') {
    return (
      <select
        id={id}
        name={name}
        required={mark}
        aria-invalid={invalid}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-[var(--kb-border)] bg-transparent px-3 py-2 text-sm"
      >
        <option value="">—</option>
        {def.options.map((option) => (
          <option key={option.value} value={option.value}>
            {optionLabel(option, locale)}
          </option>
        ))}
      </select>
    );
  }

  if (def.type === 'multi_select') {
    const chosen = selectedValues(value);
    return (
      <div role="group" aria-label={label} className="flex flex-col gap-1.5">
        {def.options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name={name}
              value={option.value}
              className="size-4"
              checked={chosen.includes(option.value)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...chosen, option.value]
                    : chosen.filter((entry) => entry !== option.value),
                )
              }
            />
            {optionLabel(option, locale)}
          </label>
        ))}
      </div>
    );
  }

  return (
    <Input
      id={id}
      name={name}
      type={
        def.type === 'number' || def.type === 'decimal'
          ? 'number'
          : def.type === 'date'
            ? 'date'
            : def.type === 'datetime'
              ? 'datetime-local'
              : 'text'
      }
      step={def.type === 'decimal' ? 'any' : def.type === 'number' ? '1' : undefined}
      min={def.validation?.min}
      max={def.validation?.max}
      minLength={def.validation?.minLength}
      maxLength={def.validation?.maxLength}
      pattern={def.type === 'text' ? def.validation?.pattern : undefined}
      required={mark}
      aria-invalid={invalid}
      value={text}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function Submit({ locale }: { locale: Locale }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="accent" disabled={pending} className="self-start">
      {pending ? t(locale, 'submitting') : t(locale, 'createTicket')}
    </Button>
  );
}
