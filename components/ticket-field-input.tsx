'use client';

import { Input, Textarea } from '@/components/ui';
import type { Locale } from '@/lib/kb/locale';
import { optionLabel, selectedValues, type TicketFieldDef } from '@/lib/tickets/custom-fields';

/**
 * One custom field's input, wherever the field is being answered.
 *
 * Shared by the help centre's form and the console's, because the alternative
 * is two renderers that disagree about what a multi-select submits or whether a
 * decimal accepts a fraction — and the one that would drift is the console's,
 * which fewer people look at.
 *
 * `surface` is the only thing the two surfaces differ on, and it covers exactly
 * one control. Every other input here comes from `components/ui`, whose colours
 * are CSS variables the help centre re-points; a native `<select>` cannot be,
 * so it carries the palette it is standing in.
 */
export type FieldSurface = 'console' | 'help';

function selectClass(surface: FieldSurface): string {
  return surface === 'help'
    ? 'w-full rounded-md border border-[var(--kb-border)] bg-transparent px-3 py-2 text-sm'
    : 'w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm';
}

export function TicketFieldInput({
  id,
  def,
  locale,
  label,
  value,
  required,
  invalid,
  onChange,
  surface,
}: {
  id: string;
  def: TicketFieldDef;
  locale: Locale;
  label: string;
  value: unknown;
  required: boolean;
  invalid: boolean;
  onChange: (value: unknown) => void;
  surface: FieldSurface;
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
        className={selectClass(surface)}
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
