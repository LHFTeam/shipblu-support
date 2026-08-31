'use client';

import { useEffect, useState } from 'react';
import { Select } from '@/components/ui';
import type { Operator } from '@/lib/rules/conditions';

/**
 * Builds the `conditions` jsonb that SLA policies and automation rules share.
 *
 * A flat list of comparisons joined by all/any, which is the shape Freshdesk
 * offers and covers essentially every rule a support team writes. Arbitrary
 * nesting is possible in the language and is reachable here through the JSON
 * escape hatch — a visual editor for nested boolean trees costs far more to
 * build and to use than the handful of rules that would need it.
 *
 * The value is serialised into a hidden input rather than posted as separate
 * fields, so the server validates exactly the document that will be stored.
 *
 * The form builder embeds one of these per question, where a hidden input of its
 * own would be a second document the server has to reconcile with the first — so
 * `name` and `onChange` are alternatives: give it a name and it posts itself,
 * give it a callback and it hands its value to whoever owns the document it is
 * part of. Reused rather than reimplemented because a second condition editor
 * would be a second dialect, and an admin would have to learn which screen
 * spoke which.
 */

export type FieldOption = {
  value: string;
  label: string;
  kind: 'text' | 'number' | 'choice';
  choices?: { value: string; label: string }[];
};

const OPERATORS: {
  value: Operator;
  label: string;
  kinds: FieldOption['kind'][];
  unary?: boolean;
}[] = [
  { value: 'eq', label: 'is', kinds: ['text', 'number', 'choice'] },
  { value: 'ne', label: 'is not', kinds: ['text', 'number', 'choice'] },
  { value: 'in', label: 'is any of', kinds: ['text', 'choice'] },
  { value: 'not_in', label: 'is none of', kinds: ['text', 'choice'] },
  { value: 'contains', label: 'contains', kinds: ['text'] },
  { value: 'not_contains', label: 'does not contain', kinds: ['text'] },
  { value: 'starts_with', label: 'starts with', kinds: ['text'] },
  { value: 'ends_with', label: 'ends with', kinds: ['text'] },
  { value: 'gt', label: 'is more than', kinds: ['number'] },
  { value: 'gte', label: 'is at least', kinds: ['number'] },
  { value: 'lt', label: 'is less than', kinds: ['number'] },
  { value: 'lte', label: 'is at most', kinds: ['number'] },
  { value: 'is_set', label: 'is set', kinds: ['text', 'number', 'choice'], unary: true },
  { value: 'is_empty', label: 'is empty', kinds: ['text', 'number', 'choice'], unary: true },
];

type Row = { field: string; op: Operator; value: string };

export function ConditionBuilder({
  name,
  fields,
  initial,
  onChange,
}: {
  /** Posts the document itself. Omit when an owner is collecting it instead. */
  name?: string;
  fields: FieldOption[];
  initial: unknown;
  onChange?: (value: unknown) => void;
}) {
  const parsed = fromJson(initial, fields);
  const [match, setMatch] = useState<'all' | 'any'>(parsed.match);
  const [rows, setRows] = useState<Row[]>(parsed.rows);
  const [raw, setRaw] = useState<string | null>(parsed.unsupported ? pretty(initial) : null);

  const json = raw ?? toJson(match, rows);

  // Fires on mount too, which is deliberate: it normalises whatever was stored
  // into what the builder can represent, so the owner's document and this
  // editor cannot disagree about a condition nobody touched.
  useEffect(() => {
    onChange?.(safeParse(json) ?? {});
    // `onChange` is a fresh closure on every parent render; depending on it
    // would re-run this on every keystroke elsewhere in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json]);

  return (
    <div className="flex flex-col gap-2">
      {name ? <input type="hidden" name={name} value={json} /> : null}

      {raw === null ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[var(--muted-foreground)]">Match</span>
            <Select
              value={match}
              onChange={(event) => setMatch(event.target.value as 'all' | 'any')}
              className="w-32"
            >
              <option value="all">all of these</option>
              <option value="any">any of these</option>
            </Select>
            {rows.length === 0 ? (
              <span className="text-xs text-[var(--muted-foreground)]">
                No conditions — this applies to every ticket.
              </span>
            ) : null}
          </div>

          {rows.map((row, index) => {
            const field = fields.find((f) => f.value === row.field) ?? fields[0]!;
            const operators = OPERATORS.filter((op) => op.kinds.includes(field.kind));
            const unary = OPERATORS.find((op) => op.value === row.op)?.unary;

            return (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Select
                  value={row.field}
                  onChange={(event) => update(index, { ...row, field: event.target.value })}
                  className="w-48"
                >
                  {fields.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>

                <Select
                  value={row.op}
                  onChange={(event) =>
                    update(index, { ...row, op: event.target.value as Operator })
                  }
                  className="w-40"
                >
                  {operators.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>

                {unary ? null : field.choices ? (
                  <Select
                    value={row.value}
                    onChange={(event) => update(index, { ...row, value: event.target.value })}
                    className="w-48"
                  >
                    <option value="">Choose…</option>
                    {field.choices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <input
                    value={row.value}
                    onChange={(event) => update(index, { ...row, value: event.target.value })}
                    placeholder={
                      row.op === 'in' || row.op === 'not_in' ? 'comma, separated, values' : 'value'
                    }
                    className="w-48 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
                  />
                )}

                <button
                  type="button"
                  onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  Remove
                </button>
              </div>
            );
          })}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setRows([...rows, { field: fields[0]!.value, op: 'eq', value: '' }])}
              className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"
            >
              + Add condition
            </button>
            <button
              type="button"
              onClick={() => setRaw(json)}
              className="text-xs text-[var(--muted-foreground)] hover:underline"
            >
              Edit as JSON
            </button>
          </div>
        </>
      ) : (
        <>
          <textarea
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            rows={6}
            spellCheck={false}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => {
              const back = fromJson(safeParse(raw), fields);
              if (back.unsupported) return;
              setMatch(back.match);
              setRows(back.rows);
              setRaw(null);
            }}
            className="self-start text-xs text-[var(--muted-foreground)] hover:underline"
          >
            Back to the builder (only if these conditions fit it)
          </button>
        </>
      )}
    </div>
  );

  function update(index: number, row: Row) {
    setRows(rows.map((existing, i) => (i === index ? row : existing)));
  }
}

function toJson(match: 'all' | 'any', rows: Row[]): string {
  const usable = rows.filter((row) => row.field);
  if (usable.length === 0) return '{}';

  const comparisons = usable.map((row) => {
    if (row.op === 'is_set' || row.op === 'is_empty') {
      return { field: row.field, op: row.op };
    }
    if (row.op === 'in' || row.op === 'not_in') {
      return {
        field: row.field,
        op: row.op,
        value: row.value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      };
    }
    // Numbers stay numbers: the comparison operators coerce, but storing "4"
    // where 4 was meant makes the stored rule harder to read.
    const numeric = Number(row.value);
    const value = row.value !== '' && Number.isFinite(numeric) ? numeric : row.value;
    return { field: row.field, op: row.op, value };
  });

  if (comparisons.length === 1) return JSON.stringify(comparisons[0], null, 2);
  return JSON.stringify({ [match]: comparisons }, null, 2);
}

function fromJson(
  input: unknown,
  fields: FieldOption[],
): { match: 'all' | 'any'; rows: Row[]; unsupported: boolean } {
  const fallbackField = fields[0]?.value ?? 'priority';
  if (!input || typeof input !== 'object') {
    return { match: 'all', rows: [], unsupported: false };
  }

  const node = input as Record<string, unknown>;
  if (Object.keys(node).length === 0) return { match: 'all', rows: [], unsupported: false };

  const asRow = (value: unknown): Row | null => {
    if (!value || typeof value !== 'object') return null;
    const comparison = value as Record<string, unknown>;
    if (typeof comparison.field !== 'string' || typeof comparison.op !== 'string') return null;

    return {
      field: comparison.field,
      op: comparison.op as Operator,
      value: Array.isArray(comparison.value)
        ? comparison.value.join(', ')
        : comparison.value === undefined || comparison.value === null
          ? ''
          : String(comparison.value),
    };
  };

  for (const key of ['all', 'any'] as const) {
    if (Array.isArray(node[key])) {
      const rows = (node[key] as unknown[]).map(asRow);
      if (rows.every((row): row is Row => row !== null)) {
        return { match: key, rows, unsupported: false };
      }
      return { match: key, rows: [], unsupported: true };
    }
  }

  const single = asRow(node);
  if (single) return { match: 'all', rows: [single], unsupported: false };

  // `not`, nested groups, anything else — shown as JSON rather than silently
  // flattened into something that means something different.
  return { match: 'all', rows: [{ field: fallbackField, op: 'eq', value: '' }], unsupported: true };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '{}';
  }
}
