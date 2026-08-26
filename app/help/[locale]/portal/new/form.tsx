'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, ErrorText, Input, Label, Textarea } from '@/components/ui';
import { t, type Locale } from '@/lib/kb/locale';
import type { TicketFieldDef } from '@/lib/tickets/custom-fields';
import { createPortalTicket, type PortalTicketState } from '../actions';

const INITIAL: PortalTicketState = { error: null };

export function NewTicketForm({
  locale,
  fields,
  subject = '',
}: {
  locale: Locale;
  fields: TicketFieldDef[];
  /** Seeded from the query string; see the comment on the page above. */
  subject?: string;
}) {
  const [state, action] = useActionState(createPortalTicket, INITIAL);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="locale" value={locale} />

      <div>
        <Label htmlFor="subject">{t(locale, 'subject')}</Label>
        <Input
          id="subject"
          name="subject"
          defaultValue={subject}
          required
          autoFocus
          maxLength={200}
        />
      </div>

      <div>
        <Label htmlFor="body">{t(locale, 'message')}</Label>
        <Textarea id="body" name="body" rows={8} required />
      </div>

      {fields.map((field) => (
        <CustomField
          key={field.key}
          field={field}
          missing={state.missing?.includes(field.key) ?? false}
        />
      ))}

      <ErrorText>{state.error ? t(locale, state.error) : null}</ErrorText>

      <Submit locale={locale} />
    </form>
  );
}

/**
 * One of the extra questions an admin has added to the ticket form.
 *
 * The label is rendered as the admin wrote it, in whatever language that was.
 * `ticket_fields.label` has no per-locale variant — the same limitation
 * `ticket_statuses.customer_label` has, and the same answer: showing the one
 * string there is beats inventing a translation. An admin who wants this read on
 * an Arabic help centre writes the label in Arabic.
 *
 * `required` is set on the input as well as checked on the server. The attribute
 * is the fast answer that never reaches the network; the server check is the one
 * that is true.
 */
function CustomField({ field, missing }: { field: TicketFieldDef; missing: boolean }) {
  const name = `custom.${field.key}`;
  const id = `field-${field.key}`;
  const required = field.requiredOnCreate;

  // A checkbox is answered by either state, so `required` on it would mean
  // "must tick", which is not what a required field means here — see
  // `isBlank` in lib/tickets/custom-fields.ts.
  const markRequired = required && field.type !== 'checkbox';

  return (
    <div>
      {field.type === 'checkbox' ? null : (
        <Label htmlFor={id}>
          {field.label}
          {markRequired ? <span aria-hidden="true"> *</span> : null}
        </Label>
      )}

      {field.type === 'paragraph' ? (
        <Textarea id={id} name={name} rows={4} required={markRequired} aria-invalid={missing} />
      ) : field.type === 'checkbox' ? (
        <label className="flex items-center gap-2 text-sm">
          <input id={id} type="checkbox" name={name} className="size-4" />
          {field.label}
        </label>
      ) : field.type === 'dropdown' ? (
        <select
          id={id}
          name={name}
          required={markRequired}
          aria-invalid={missing}
          className="w-full rounded-md border border-[var(--kb-border)] bg-transparent px-3 py-2 text-sm"
        >
          <option value="">—</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'multi_select' ? (
        <div role="group" aria-label={field.label} className="flex flex-col gap-1.5">
          {field.options.map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={name} value={option.value} className="size-4" />
              {option.label}
            </label>
          ))}
        </div>
      ) : (
        <Input
          id={id}
          name={name}
          type={
            field.type === 'number' || field.type === 'decimal'
              ? 'number'
              : field.type === 'date'
                ? 'date'
                : field.type === 'datetime'
                  ? 'datetime-local'
                  : 'text'
          }
          step={field.type === 'decimal' ? 'any' : field.type === 'number' ? '1' : undefined}
          required={markRequired}
          aria-invalid={missing}
        />
      )}
    </div>
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
