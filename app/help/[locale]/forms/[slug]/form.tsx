'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Input, Label, Textarea } from '@/components/ui';
import { TicketFieldInput } from '@/components/ticket-field-input';
import { ACCEPT_ATTRIBUTE, MAX_FORM_FILES } from '@/lib/forms/files';
import {
  elementHelp,
  elementLabel,
  elementText,
  elementToken,
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
      {/* Kept even when no subject question is on the form — it is the fallback
          subject, not an answer, so `renderSubject` uses it only when nothing
          else produced one. */}
      <input type="hidden" name="subjectSeed" value={subject} />

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
            missing={state.missing?.includes(elementToken(element)) ?? false}
            invalid={state.invalid?.includes(elementToken(element)) ?? false}
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
      ) : def?.type === 'checkbox' ? (
        <label className="flex items-center gap-2 text-sm">
          <TicketFieldInput
            id={id}
            def={def}
            locale={locale}
            label={label}
            value={custom[def.key]}
            required={required}
            invalid={missing || invalid}
            onChange={onCustom}
            surface="help"
          />
          {label}
        </label>
      ) : (
        <TicketFieldInput
          id={id}
          def={def!}
          locale={locale}
          label={label}
          value={custom[def!.key]}
          required={required}
          invalid={missing || invalid}
          onChange={onCustom}
          surface="help"
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

  // No `priority` branch, deliberately. `AGENT_ONLY_SYSTEM` means `elementsFor`
  // never hands a customer that element, so a control here could only ever be
  // dead code that a later reader mistakes for a feature — customers grading
  // their own urgency is the queue that is entirely urgent.

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

function Submit({ locale }: { locale: Locale }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="accent" disabled={pending} className="self-start">
      {pending ? t(locale, 'submitting') : t(locale, 'createTicket')}
    </Button>
  );
}
