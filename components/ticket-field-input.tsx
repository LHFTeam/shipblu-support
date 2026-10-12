'use client';

import { Input, Select, Textarea } from '@/components/ui';
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
 * Both surfaces draw it from `components/ui`, native `<select>` included. The
 * help centre once needed its own select because its palette lived on
 * `.kb-shell` and a native control could not be re-pointed at it; the two now
 * read the same roles, so one set of controls serves both.
 */
export function TicketFieldInput({
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
  // `String(value)`, not a string check. `parseFieldValue` deliberately stores a
  // number as a number, so any caller seeding this from `custom_fields` — which
  // is what a shared input invites — rendered an empty box over a stored answer,
  // and saving then cleared it.
  const text = value === null || value === undefined ? '' : String(value);

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
    // The bare input, with no label of its own. Each surface labels it: the
    // help centre puts the wording beside the box, the console's `Field` puts it
    // above. Rendering one here as well nested a <label> inside a <label>, which
    // is invalid and made the click target ambiguous.
    return (
      <input
        id={id}
        type="checkbox"
        name={name}
        className="size-4 shrink-0 accent-blu-500"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }

  if (def.type === 'dropdown') {
    return (
      <Select
        id={id}
        name={name}
        required={mark}
        aria-invalid={invalid}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">—</option>
        {def.options.map((option) => (
          <option key={option.value} value={option.value}>
            {optionLabel(option, locale)}
          </option>
        ))}
      </Select>
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
              className="size-4 shrink-0 accent-blu-500"
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
