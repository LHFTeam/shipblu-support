'use client';

import { useId, useState } from 'react';
import { Input, Select } from '@/components/ui';
import { SYSTEM_KEYS, type SystemKey } from '@/lib/forms/elements';
import { PRIORITY_CHOICES } from '@/lib/tickets/vocabulary';
import { ConditionBuilder, type FieldOption } from '../condition-builder';

/**
 * Builds the list of questions a ticket form asks.
 *
 * The whole document goes into one hidden input, the way
 * `./action-builder.tsx` posts an automation's actions — so the server
 * validates exactly what will be stored, rather than reassembling it from
 * thirty named inputs whose relationship only this component knows.
 *
 * Ordering is move-up/move-down buttons and not drag-and-drop. Nothing in this
 * console drags, a form is rarely more than a dozen questions, and a drag
 * handle is the control that does not work on the phone the console is actually
 * read on.
 */

/** The custom fields this form can place, passed down by the page. */
export type FieldChoice = {
  key: string;
  label: string;
  type: string;
  options: { value: string; label: string }[];
  /**
   * Whether a customer may read and write it. A field that is neither is still
   * placeable — an agent-facing form is a real use — but it is dropped from the
   * help centre's rendering, so the picker says so rather than letting somebody
   * build a public form that quietly asks one question fewer.
   */
  internal: boolean;
  /** Deactivated. Still offered, because a form may already place it. */
  retired: boolean;
};

const KINDS = [
  { value: 'field', label: 'A custom field' },
  { value: 'system', label: 'A built-in question' },
  { value: 'heading', label: 'A heading' },
  { value: 'note', label: 'A note' },
] as const;

const SYSTEM_LABELS: Record<SystemKey, string> = {
  subject: 'Subject',
  description: 'Message',
  attachments: 'Attachments',
  requester_name: 'Their name (forms anybody can submit)',
  requester_email: 'Their email (forms anybody can submit)',
  priority: 'Priority (agents only)',
};

type Item = {
  /** Editor-only identity, so expanding a row survives reordering. */
  uid: string;
  kind: 'field' | 'system' | 'heading' | 'note';
  key: string;
  textAr: string;
  textEn: string;
  labelAr: string;
  labelEn: string;
  helpAr: string;
  helpEn: string;
  /** '' inherits, 'yes' and 'no' override. */
  required: '' | 'yes' | 'no';
  visibility: unknown;
};

export function ElementsBuilder({
  name,
  fields,
  initial,
}: {
  name: string;
  fields: FieldChoice[];
  initial: unknown;
}) {
  const [items, setItems] = useState<Item[]>(() => fromJson(initial));
  const [open, setOpen] = useState<string | null>(null);
  const prefix = useId();

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={toJson(items)} />

      {items.map((item, index) => (
        <div
          key={item.uid}
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-5 text-xs text-[var(--muted-foreground)]">{index + 1}.</span>

            <Select
              aria-label="Question type"
              value={item.kind}
              onChange={(event) =>
                update(index, { ...item, kind: event.target.value as Item['kind'], key: '' })
              }
              className="w-44"
            >
              {KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>

            <Target
              item={item}
              fields={fields}
              taken={items}
              onChange={(patch) => update(index, { ...item, ...patch })}
            />

            <div className="ms-auto flex items-center gap-1">
              <Move label="Move up" disabled={index === 0} onClick={() => swap(index, index - 1)}>
                ↑
              </Move>
              <Move
                label="Move down"
                disabled={index === items.length - 1}
                onClick={() => swap(index, index + 1)}
              >
                ↓
              </Move>
              <button
                type="button"
                onClick={() => setOpen(open === item.uid ? null : item.uid)}
                aria-expanded={open === item.uid}
                aria-controls={`${prefix}-${item.uid}`}
                className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {open === item.uid ? 'Done' : 'Wording and rules'}
              </button>
              <button
                type="button"
                onClick={() => setItems(items.filter((_, i) => i !== index))}
                className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                Remove
              </button>
            </div>
          </div>

          {open === item.uid ? (
            <div
              id={`${prefix}-${item.uid}`}
              className="mt-3 flex flex-col gap-3 border-t border-[var(--border)] pt-3"
            >
              {item.kind === 'heading' || item.kind === 'note' ? null : (
                <>
                  <Pair
                    label="Label shown to the person filling it in"
                    hint="Blank uses the field’s own wording, then its internal name."
                    ar={item.labelAr}
                    en={item.labelEn}
                    onAr={(value) => update(index, { ...item, labelAr: value })}
                    onEn={(value) => update(index, { ...item, labelEn: value })}
                  />
                  <Pair
                    label="Help text under the input"
                    hint="Always on screen, which is where an explanation belongs when it is the reason somebody answers correctly."
                    ar={item.helpAr}
                    en={item.helpEn}
                    onAr={(value) => update(index, { ...item, helpAr: value })}
                    onEn={(value) => update(index, { ...item, helpEn: value })}
                  />

                  <label className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-[var(--muted-foreground)]">Answering it is</span>
                    <Select
                      value={item.required}
                      onChange={(event) =>
                        update(index, { ...item, required: event.target.value as Item['required'] })
                      }
                      className="w-56"
                    >
                      <option value="">whatever the field itself says</option>
                      <option value="yes">required on this form</option>
                      <option value="no">optional on this form</option>
                    </Select>
                  </label>
                </>
              )}

              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">Only ask this when…</p>
                <p className="text-xs text-[var(--muted-foreground)]">
                  Written against the questions <em>above</em> this one — a question can only depend
                  on one that has already been asked. No conditions means it is always shown.
                </p>
                <ConditionBuilder
                  fields={vocabulary(items.slice(0, index), fields)}
                  initial={item.visibility}
                  onChange={(value) => update(index, { ...item, visibility: value })}
                />
              </div>
            </div>
          ) : null}
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        {KINDS.map((kind) => (
          <button
            key={kind.value}
            type="button"
            onClick={() => setItems([...items, blank(kind.value)])}
            className="text-xs font-medium text-brand-600 hover:underline"
          >
            + {kind.label}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-[var(--muted-foreground)]">
          An empty form still opens a ticket, but it asks nothing — add the message question at
          least.
        </p>
      ) : null}
    </div>
  );

  function update(index: number, item: Item) {
    setItems(items.map((existing, i) => (i === index ? item : existing)));
  }

  function swap(from: number, to: number) {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    [next[from], next[to]] = [next[to]!, next[from]!];
    setItems(next);
  }
}

function Move({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded px-1.5 py-0.5 text-xs text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** What this row is pointing at: a field, a built-in question, or its own text. */
function Target({
  item,
  fields,
  taken,
  onChange,
}: {
  item: Item;
  fields: FieldChoice[];
  taken: Item[];
  onChange: (patch: Partial<Item>) => void;
}) {
  if (item.kind === 'heading' || item.kind === 'note') {
    return (
      <div className="flex flex-1 flex-wrap gap-2">
        <Input
          aria-label="Arabic text"
          dir="rtl"
          lang="ar"
          value={item.textAr}
          onChange={(event) => onChange({ textAr: event.target.value })}
          placeholder="بالعربية"
          className="min-w-40 flex-1"
        />
        <Input
          aria-label="English text"
          value={item.textEn}
          onChange={(event) => onChange({ textEn: event.target.value })}
          placeholder="In English"
          className="min-w-40 flex-1"
        />
      </div>
    );
  }

  // A question already on the form is not offered again: two inputs writing one
  // key store one answer, and nobody can tell which was kept.
  const used = new Set(taken.filter((entry) => entry.kind === item.kind).map((entry) => entry.key));

  const choices =
    item.kind === 'field'
      ? fields.map((field) => ({
          value: field.key,
          label: `${field.label}${field.retired ? ' (deactivated)' : field.internal ? ' (agents only)' : ''}`,
        }))
      : SYSTEM_KEYS.map((key) => ({ value: key, label: SYSTEM_LABELS[key] }));

  return (
    <Select
      aria-label="Which question"
      value={item.key}
      onChange={(event) => onChange({ key: event.target.value })}
      className="w-64"
    >
      <option value="">Choose…</option>
      {choices
        .filter((choice) => choice.value === item.key || !used.has(choice.value))
        .map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
    </Select>
  );
}

function Pair({
  label,
  hint,
  ar,
  en,
  onAr,
  onEn,
}: {
  label: string;
  hint: string;
  ar: string;
  en: string;
  onAr: (value: string) => void;
  onEn: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label={`${label}, Arabic`}
          dir="rtl"
          lang="ar"
          value={ar}
          onChange={(event) => onAr(event.target.value)}
          placeholder="بالعربية"
        />
        <Input
          aria-label={`${label}, English`}
          value={en}
          onChange={(event) => onEn(event.target.value)}
          placeholder="In English"
        />
      </div>
      <span className="text-xs text-[var(--muted-foreground)]">{hint}</span>
    </div>
  );
}

/**
 * The vocabulary a condition on this row may be written against.
 *
 * Only the questions above it, and that is not a UI nicety: visibility is
 * resolved by building up from nothing, so a question conditioned on one asked
 * later can only ever be answered "not yet" — offering it would let an admin
 * write a rule that silently never fires.
 */
function vocabulary(before: Item[], fields: FieldChoice[]): FieldOption[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const options: FieldOption[] = [];

  for (const item of before) {
    if (item.kind === 'field') {
      const field = byKey.get(item.key);
      if (!field) continue;
      options.push({
        value: `custom.${field.key}`,
        label: item.labelEn || field.label,
        kind:
          field.type === 'number' || field.type === 'decimal'
            ? 'number'
            : field.options.length
              ? 'choice'
              : 'text',
        choices: field.options.length ? field.options : undefined,
      });
      continue;
    }

    if (item.kind !== 'system' || !item.key) continue;

    const key = item.key as SystemKey;
    if (key === 'attachments') {
      options.push({ value: 'attachments', label: 'Number of files attached', kind: 'number' });
    } else if (key === 'priority') {
      options.push({
        value: 'priority',
        label: 'Priority',
        kind: 'choice',
        choices: PRIORITY_CHOICES,
      });
    } else {
      options.push({ value: key, label: SYSTEM_LABELS[key], kind: 'text' });
    }
  }

  // Never empty: `ConditionBuilder` picks `fields[0]` for a new row, and an
  // empty list would make "+ Add condition" throw on the first question.
  if (options.length === 0) {
    options.push({ value: 'subject', label: 'Subject', kind: 'text' });
  }

  return options;
}

let counter = 0;
function uid(): string {
  counter += 1;
  return `e${counter}`;
}

function blank(kind: Item['kind']): Item {
  return {
    uid: uid(),
    kind,
    key: '',
    textAr: '',
    textEn: '',
    labelAr: '',
    labelEn: '',
    helpAr: '',
    helpEn: '',
    required: '',
    visibility: {},
  };
}

/**
 * The stored document, with the editor's own bookkeeping stripped and blank
 * overrides left out entirely — so a form nobody has customised stores the
 * questions and nothing else, and a jsonb dump reads as what an admin built.
 */
function toJson(items: Item[]): string {
  // Nothing is filtered out here, and that is the point. Dropping a row whose
  // field was never chosen is the same silent discard `saveTicketForm` refuses
  // to make — it would leave the counts agreeing, the save reporting success,
  // and the admin's half-built question gone. Posted as-is, it fails the parse
  // and the save says so.
  const document = items.map((item) => {
    const visibility =
      item.visibility && Object.keys(item.visibility as object).length ? item.visibility : {};

    if (item.kind === 'heading' || item.kind === 'note') {
      return { kind: item.kind, textAr: item.textAr, textEn: item.textEn, visibility };
    }

    return {
      kind: item.kind,
      key: item.key,
      ...(item.labelAr ? { labelAr: item.labelAr } : {}),
      ...(item.labelEn ? { labelEn: item.labelEn } : {}),
      ...(item.helpAr ? { helpAr: item.helpAr } : {}),
      ...(item.helpEn ? { helpEn: item.helpEn } : {}),
      ...(item.required ? { required: item.required === 'yes' } : {}),
      visibility,
    };
  });

  return JSON.stringify(document, null, 2);
}

function fromJson(input: unknown): Item[] {
  if (!Array.isArray(input)) return [];

  return input.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const node = entry as Record<string, unknown>;

    const kind = node.kind;
    if (kind !== 'field' && kind !== 'system' && kind !== 'heading' && kind !== 'note') return [];

    const asText = (value: unknown) => (typeof value === 'string' ? value : '');

    return [
      {
        ...blank(kind),
        key: asText(node.key),
        textAr: asText(node.textAr),
        textEn: asText(node.textEn),
        labelAr: asText(node.labelAr),
        labelEn: asText(node.labelEn),
        helpAr: asText(node.helpAr),
        helpEn: asText(node.helpEn),
        required: node.required === true ? 'yes' : node.required === false ? 'no' : '',
        visibility: node.visibility ?? {},
      } satisfies Item,
    ];
  });
}
